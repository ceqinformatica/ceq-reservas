// Mini PostgREST en memoria para probar server.js sin Supabase. Soporta lo que usa el servidor:
// filtros eq/neq/in/is/gte/lte/gt/lt, select de columnas, order (varias columnas), limit/offset
// (con el tope de 1000 filas de Supabase), insert, upsert (on_conflict de varias columnas),
// update y delete con return=representation, y restricciones únicas.
const http = require('http');

function crearMiniPostgrest(db, { unicas = {}, porDefecto = {}, fallar = () => false } = {}) {
  const siguiente = {};
  const nuevoId = t => (siguiente[t] = Math.max(siguiente[t] || 0, ...db[t].map(f => Number(f.id) || 0)) + 1);
  const pedidos = [];

  function cumple(f, col, expr) {
    const m = expr.match(/^(not\.)?(eq|neq|in|is|gte|lte|gt|lt)\.(.*)$/s);
    if (!m) throw new Error('filtro no soportado ' + col + '=' + expr);
    const [, no, op, val] = m; const v = f[col]; let r;
    const comparar = (a, b) => { const na = Number(a), nb = Number(b); return (!isNaN(na) && !isNaN(nb) && a !== '' && b !== '' && typeof a !== 'boolean') ? na - nb : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0; };
    const fechaComparable = x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(x) ? new Date(/(Z|[+-]\d{2}:?\d{2})$/.test(x) ? x : x + 'Z').getTime() : x;
    const a = fechaComparable(v), b = fechaComparable(val);
    if (op === 'eq') r = String(v) === val;
    else if (op === 'neq') r = String(v) !== val;
    else if (op === 'in') r = val.replace(/^\(|\)$/g, '').split(',').map(x => x.replace(/^"|"$/g, '')).includes(String(v));
    else if (op === 'is') r = val === 'null' ? v == null : String(v) === val;
    else if (v == null) r = false;
    else { const c = comparar(a, b); r = op === 'gte' ? c >= 0 : op === 'lte' ? c <= 0 : op === 'gt' ? c > 0 : c < 0; }
    return no ? !r : r;
  }
  const NO_FILTROS = ['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'];
  const filtrar = (filas, p) => filas.filter(f => [...p].every(([k, v]) => NO_FILTROS.includes(k) || cumple(f, k, v)));
  const proyectar = (filas, sel) => !sel || sel === '*' ? filas.map(f => ({ ...f })) : filas.map(f => Object.fromEntries(sel.split(',').map(c => c.trim()).map(c => [c, f[c] === undefined ? null : f[c]])));

  const servidor = http.createServer((rq, rs) => {
    let cuerpo = '';
    rq.on('data', c => cuerpo += c);
    rq.on('end', () => {
      const url = new URL(rq.url, 'http://x');
      const tabla = url.pathname.replace('/rest/v1/', '');
      const p = url.searchParams; const prefer = rq.headers.prefer || '';
      pedidos.push({ metodo: rq.method, tabla, consulta: p.toString(), cuerpo });
      const enviar = (st, datos, extra = {}) => { rs.writeHead(st, { 'content-type': 'application/json', ...extra }); rs.end(datos === undefined ? '' : JSON.stringify(datos)); };
      try {
        if (fallar(tabla, rq.method)) return enviar(500, { code: 'XX000', message: 'falla simulada' });
        if (!db[tabla]) return enviar(404, { code: '42P01', message: 'no existe ' + tabla });
        const representar = filas => prefer.includes('return=representation') ? enviar(rq.method === 'POST' ? 201 : 200, proyectar(filas, p.get('select'))) : enviar(rq.method === 'POST' ? 201 : 204);
        const chequearUnicas = (fila, ignorar) => (unicas[tabla] || []).forEach(cols => {
          if (db[tabla].some(o => o !== ignorar && cols.every(c => String(o[c]) === String(fila[c])))) { const e = new Error('duplicado'); e.codigo = '23505'; throw e; }
        });
        if (rq.method === 'GET' || rq.method === 'HEAD') {
          let filas = filtrar(db[tabla], p);
          if (p.get('order')) {
            const crit = p.get('order').split(',').map(o => o.split('.'));
            filas = [...filas].sort((x, y) => { for (const [c, d] of crit) { if (x[c] !== y[c]) return (x[c] > y[c] ? 1 : -1) * (d === 'desc' ? -1 : 1); } return 0; });
          }
          const off = Number(p.get('offset') || 0); const lim = Math.min(Number(p.get('limit') || 1000), 1000);
          filas = filas.slice(off, off + lim);
          return enviar(200, proyectar(filas, p.get('select')));
        }
        if (rq.method === 'POST') {
          const conf = p.get('on_conflict');
          const resultado = [];
          for (const n of [].concat(JSON.parse(cuerpo))) {
            const cols = conf ? conf.split(',') : null;
            const existente = cols && db[tabla].find(f => cols.every(c => String(f[c]).replace(/:00$/, '') === String(n[c]).replace(/:00$/, '')));
            if (existente) {
              if (prefer.includes('ignore-duplicates')) continue;
              if (prefer.includes('merge-duplicates')) { Object.assign(existente, n); resultado.push(existente); continue; }
            }
            const fila = { ...(porDefecto[tabla] ? porDefecto[tabla]() : {}), ...n };
            if (tabla !== 'configuracion' && fila.id === undefined) fila.id = nuevoId(tabla);
            chequearUnicas(fila);
            db[tabla].push(fila); resultado.push(fila);
          }
          return representar(resultado);
        }
        if (rq.method === 'PATCH') { const c = JSON.parse(cuerpo); const filas = filtrar(db[tabla], p); filas.forEach(f => Object.assign(f, c)); return representar(filas); }
        if (rq.method === 'DELETE') { const filas = filtrar(db[tabla], p); db[tabla] = db[tabla].filter(f => !filas.includes(f)); return representar(filas); }
        enviar(405, { message: 'no soportado' });
      } catch (e) {
        if (e.codigo === '23505') return enviar(409, { code: '23505', message: 'duplicate key' });
        console.error('SIMULADOR:', e.message); enviar(500, { code: 'XX000', message: e.message });
      }
    });
  });
  return { servidor, pedidos };
}

module.exports = { crearMiniPostgrest };
