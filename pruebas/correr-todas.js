// Corre todas las pruebas automáticas del servidor, una detrás de otra, y al final dice si
// todo anda bien. Ninguna toca la base real, ni manda correos de verdad, ni usa claves reales:
// cada prueba levanta el server.js real contra una base de datos simulada en memoria.
//
// Uso (desde la carpeta del repo, después de `npm ci`):
//   node pruebas/correr-todas.js
// La prueba de la estructura de la base necesita además PGlite (una base Postgres de prueba):
//   npm install --no-save @electric-sql/pglite@0.5.8
// Si no está instalada, esa prueba se salta y se avisa.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const raiz = path.resolve(__dirname, '..');
const aqui = __dirname;
const ayudante = nombre => path.join(aqui, nombre);
const servidor = path.join(raiz, 'server.js');

const PRUEBAS = [
  ['Servidor: reservas, bloqueos, reportes y salud', 'probar_servidor.js', [raiz, ayudante('interceptar_brevo.js')]],
  ['Panel: admin y admin supremo', 'probar_superadmin.js', [raiz, ayudante('interceptar_brevo.js')]],
  ['Configuración, aperturas programadas, recordatorios, lista de espera, asistencia y alertas', 'probar_funciones_octubre.js', [raiz, aqui]],
  ['Planilla de Google Sheets (servidor y script)', 'probar_sincronizacion.js', [raiz, ayudante('interceptar_brevo.js'), path.join(raiz, 'sincronizar-reservas.gs')]],
  ['Correos de confirmación del Frente', 'probar_frente_correos.js', [raiz, servidor, ayudante('interceptar_brevo.js'), ayudante('reloj_falso.js')]],
  ['Altillo, motivos del Frente y acompañantes', 'probar_altillo_servidor.js', [raiz, servidor, ayudante('interceptar_brevo.js'), ayudante('reloj_falso.js')]],
  ['Copia de seguridad mensual y "Responder a" de los correos', 'probar_copia_y_responder.js', [raiz, aqui]],
  ['Ventana de novedades y espacios sin aviso', 'probar_novedades.js', [raiz, aqui]],
  ['Arreglos de la auditoría técnica (cupo, validación, cancelaciones, lista de espera, cookies)', 'probar_auditoria.js', [raiz, aqui]],
  ['Cola de correos con reintentos', 'probar_cola_correos.js', [raiz, aqui]],
  ['Panel: lista de espera, bloqueos de varios días, reportes y correos', 'probar_panel.js', [raiz, aqui]],
  ['Admin supremo: horario del Altillo, motivos, novedades, lista de espera y datos de una persona', 'probar_supremo.js', [raiz, aqui]],
  ['Herramientas del admin supremo: editar, reenviar, historial, pausa, contraseña, estado y copia', 'probar_herramientas.js', [raiz, aqui]],
  ['Personalización del admin supremo: reglas de los espacios, textos de la página y correos', 'probar_personalizacion.js', [raiz, aqui]],
  ['Plazos de conservación de la Política de Privacidad', 'probar_retencion.js', [raiz, aqui]],
  ['Estructura y reglas de la base de datos', 'probar_esquema.js', [raiz, path.join(raiz, 'esquema-base-de-datos.sql')], '@electric-sql/pglite']
];
const LIMITE_MS = 6 * 60 * 1000;
const EN_GITHUB = process.env.GITHUB_ACTIONS === 'true';
// Formato de las anotaciones de GitHub Actions (::error ...::mensaje)
const escaparGithub = s => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

function correr(archivo, args) {
  return new Promise(resolve => {
    const hijo = spawn(process.execPath, [path.join(aqui, archivo), ...args], { cwd: raiz });
    let salida = '';
    hijo.stdout.on('data', d => { salida += d; });
    hijo.stderr.on('data', d => { salida += d; });
    const reloj = setTimeout(() => { salida += '\n(se cortó: tardó más de 6 minutos)'; hijo.kill(); }, LIMITE_MS);
    hijo.on('close', codigo => { clearTimeout(reloj); resolve({ codigo, salida }); });
  });
}

(async () => {
  const resumen = [];
  for (const [nombre, archivo, args, necesita] of PRUEBAS) {
    if (necesita) {
      try { require.resolve(necesita, { paths: [raiz] }); } catch (e) {
        console.log(`\n⏭  ${nombre}: se salta (falta instalar ${necesita})`);
        resumen.push({ nombre, estado: 'saltada' });
        continue;
      }
    }
    process.stdout.write(`\n▶  ${nombre} ... `);
    const inicio = Date.now();
    const { codigo, salida } = await correr(archivo, args);
    const m = salida.match(/(\d+)\/(\d+) pruebas correctas/);
    const ok = codigo === 0 && m && m[1] === m[2];
    const segundos = Math.round((Date.now() - inicio) / 1000);
    console.log(ok ? `✅ ${m[1]}/${m[2]} (${segundos} s)` : `❌ ${m ? `${m[1]}/${m[2]}` : 'no terminó'} (${segundos} s)`);
    if (!ok) {
      // Se muestran las pruebas que fallaron (o toda la salida si no llegó al final)
      const fallas = salida.split('\n').filter(l => l.startsWith('FALLA'));
      const detalle = (fallas.length ? fallas : salida.split('\n').slice(-40)).join('\n');
      console.log(detalle.split('\n').map(l => '   ' + l).join('\n'));
      if (EN_GITHUB) console.log(`::error title=${escaparGithub(nombre)}::${escaparGithub(detalle.slice(0, 3500))}`);
    }
    resumen.push({ nombre, estado: ok ? 'bien' : 'mal', detalle: m ? `${m[1]}/${m[2]}` : '' });
  }

  const mal = resumen.filter(r => r.estado === 'mal');
  const total = resumen.reduce((s, r) => s + (r.detalle ? Number(r.detalle.split('/')[1]) : 0), 0);
  console.log('\n────────────────────────────────────────');
  console.log(mal.length === 0
    ? `✅ Todo bien: ${total} pruebas en ${resumen.filter(r => r.estado === 'bien').length} grupos.`
    : `❌ Fallaron ${mal.length} grupo(s): ${mal.map(r => r.nombre).join('; ')}`);
  if (resumen.some(r => r.estado === 'saltada')) console.log('⚠️  Hubo grupos saltados (ver arriba).');
  if (EN_GITHUB && process.env.GITHUB_STEP_SUMMARY) {
    const filas = resumen.map(r => `| ${r.estado === 'bien' ? '✅' : r.estado === 'mal' ? '❌' : '⏭'} | ${r.nombre} | ${r.detalle || '-'} |`);
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, ['## Pruebas del sistema de reservas', '', '| | Grupo | Pruebas |', '|---|---|---|', ...filas, ''].join('\n'));
  }
  if (EN_GITHUB) console.log(`::notice title=Resultado::${escaparGithub(mal.length === 0 ? `Todo bien: ${total} pruebas` : `Fallaron: ${mal.map(r => r.nombre).join('; ')}`)}`);
  process.exit(mal.length === 0 ? 0 : 1);
})();
