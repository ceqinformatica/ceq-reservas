require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración Supabase
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xftcenmlptzhxhffwtsk.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_secret_GowxJgT7b0E_ApXz2AtUJw_PIpjgVCh';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Middleware
app.use(cors());
app.use(express.json());

// Generar código único
function generarCodigo() {
  return 'RES-' + Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Obtener espacios
app.get('/api/espacios', async (req, res) => {
  try {
    const { data, error } = await supabase.from('espacios').select('*');
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Obtener reservas
app.get('/api/reservas', async (req, res) => {
  try {
    const { espacio_id, fecha } = req.query;
    let query = supabase.from('reservas').select('*').eq('estado', 'activa');
    if (espacio_id) query = query.eq('espacio_id', espacio_id);
    if (fecha) query = query.eq('fecha', fecha);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Validar disponibilidad
app.post('/api/validar-disponibilidad', async (req, res) => {
  try {
    const { espacio_id, fecha, hora_inicio, hora_fin } = req.body;
    const { data, error } = await supabase
      .from('reservas')
      .select('*')
      .eq('espacio_id', espacio_id)
      .eq('fecha', fecha)
      .eq('estado', 'activa');
    if (error) throw error;
    const disponible = !data.some(r => {
      const horaIniReserva = parseInt(r.hora_inicio.split(':')[0]);
      const horaFinReserva = parseInt(r.hora_fin.split(':')[0]);
      const horaIniNueva = parseInt(hora_inicio.split(':')[0]);
      const horaFinNueva = parseInt(hora_fin.split(':')[0]);
      return horaIniNueva < horaFinReserva && horaFinNueva > horaIniReserva;
    });
    res.json({ disponible });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Crear reserva
app.post('/api/reservas', async (req, res) => {
  try {
    const { espacio_id, nombre_solicitante, contacto, fecha, hora_inicio, hora_fin, motivo } = req.body;
    console.log('Datos recibidos:', { espacio_id, nombre_solicitante, contacto, fecha, hora_inicio, hora_fin, motivo });
    
    if (!espacio_id || !nombre_solicitante || !contacto || !fecha || !hora_inicio || !hora_fin) {
      return res.status(400).json({ error: 'Faltan datos obligatorios' });
    }
    
    const hoy = new Date().toISOString().split('T')[0];
    const mañana = new Date(Date.now() + 86400000).toISOString().split('T')[0];
    if (fecha < mañana) {
      return res.status(400).json({ error: 'Mínimo 1 día de anticipación' });
    }
    
    const fechaObj = new Date(fecha);
    const diaSemana = fechaObj.getDay();
    if (diaSemana === 0 || diaSemana === 6) {
      return res.status(400).json({ error: 'No se pueden reservar fines de semana' });
    }
    
    const [horaI, minI] = hora_inicio.split(':').map(Number);
    const [horaF, minF] = hora_fin.split(':').map(Number);
    
    // Para Frente: 07:00-18:00, para otros: 08:00-18:00
    const horaMinima = espacio_id === 3 ? 7 : 8;
    const horaMaxima = espacio_id === 3 ? 18 : 18;
    
    if (horaI < horaMinima || horaF > horaMaxima || horaI >= horaF) {
      return res.status(400).json({ error: `Horario inválido (${horaMinima}:00-${horaMaxima}:00)` });
    }
    
    // VALIDACIÓN CRÍTICA: verificar solapamientos
    const { data: existentes, error: errorBuscar } = await supabase
      .from('reservas')
      .select('*')
      .eq('espacio_id', espacio_id)
      .eq('fecha', fecha)
      .eq('estado', 'activa');
    
    if (errorBuscar) throw errorBuscar;
    
    const hay_solapamiento = existentes.some(r => {
      const horaIniR = parseInt(r.hora_inicio.split(':')[0]);
      const horaFinR = parseInt(r.hora_fin.split(':')[0]);
      return horaI < horaFinR && horaF > horaIniR;
    });
    
    if (hay_solapamiento) {
      return res.status(409).json({ error: 'Horario no disponible - otro usuario lo reservó' });
    }
    
    // Generar código ANTES de insertar
    const codigo = generarCodigo();
    
    // Intentar insertar - si falla por UNIQUE constraint, hay race condition
    const { data: nuevaReserva, error } = await supabase
      .from('reservas')
      .insert([{
        espacio_id,
        nombre_solicitante,
        contacto,
        fecha,
        hora_inicio,
        hora_fin,
        motivo: motivo || '',
        estado: 'activa',
        codigo_cancelacion: codigo
      }])
      .select();
    
    if (error) {
      if (error.code === '23505') {
        // Violación de UNIQUE constraint = race condition
        return res.status(409).json({ error: 'Horario no disponible - otro usuario lo reservó justo ahora. Por favor, actualice la página e intente con otro horario.' });
      }
      throw error;
    }
    
    res.status(201).json({
      mensaje: 'Reserva creada exitosamente',
      reserva: nuevaReserva[0],
      codigo: codigo
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Obtener reservas admin
app.get('/api/admin/reservas', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('reservas')
      .select(`
        id,
        espacio_id,
        espacios(nombre),
        nombre_solicitante,
        contacto,
        fecha,
        hora_inicio,
        hora_fin,
        estado,
        motivo,
        codigo_cancelacion,
        created_at
      `)
      .order('fecha', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cancelar reserva por código
app.post('/api/cancelar-por-codigo', async (req, res) => {
  try {
    const { codigo } = req.body;
    if (!codigo) {
      return res.status(400).json({ error: 'Código requerido' });
    }
    const { data: reservas, error: errorBuscar } = await supabase
      .from('reservas')
      .select('*')
      .eq('codigo_cancelacion', codigo)
      .eq('estado', 'activa');
    if (errorBuscar || !reservas || reservas.length === 0) {
      return res.status(404).json({ error: 'Código inválido o reserva ya cancelada' });
    }
    const reserva = reservas[0];
    const { error: errorCancelar } = await supabase
      .from('reservas')
      .update({ estado: 'cancelada' })
      .eq('id', reserva.id);
    if (errorCancelar) throw errorCancelar;
    res.json({ mensaje: 'Reserva cancelada exitosamente', reserva_id: reserva.id });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Cancelar reserva admin
app.post('/api/admin/cancelar/:reserva_id', async (req, res) => {
  try {
    const { reserva_id } = req.params;
    const { motivo } = req.body;
    const { error } = await supabase
      .from('reservas')
      .update({ estado: 'cancelada' })
      .eq('id', reserva_id);
    if (error) throw error;
    res.json({ mensaje: 'Reserva cancelada', reserva_id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Obtener reportes
app.get('/api/admin/reportes', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('reportes_errores')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Crear reporte
app.post('/api/reportes', async (req, res) => {
  try {
    const { mensaje, url, navegador } = req.body;
    if (!mensaje) {
      return res.status(400).json({ error: 'Mensaje requerido' });
    }
    const { data, error } = await supabase
      .from('reportes_errores')
      .insert([{
        mensaje,
        url: url || '',
        navegador: navegador || '',
        leido: false
      }])
      .select();
    if (error) throw error;
    res.status(201).json({ mensaje: 'Reporte guardado', reporte: data[0] });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Marcar reporte como leído
app.post('/api/admin/reportes/:id/leer', async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('reportes_errores')
      .update({ leido: true })
      .eq('id', id)
      .select();
    if (error) throw error;
    res.json({ mensaje: 'Marcado como leído', reporte: data[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Estadísticas
app.get('/api/estadisticas', async (req, res) => {
  try {
    const { data: activas } = await supabase
      .from('reservas')
      .select('id')
      .eq('estado', 'activa');
    res.json({
      reservas_activas: activas?.length || 0
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// BLOQUEOS
app.get('/api/bloqueos', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bloqueos')
      .select('*')
      .order('fecha', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bloqueos', async (req, res) => {
  try {
    const { espacio_id, fecha, hora_inicio, hora_fin, motivo } = req.body;

    if (!espacio_id || !fecha || !hora_inicio || !hora_fin) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    const [horaI, minI] = hora_inicio.split(':').map(Number);
    const [horaF, minF] = hora_fin.split(':').map(Number);
    
    const horaMinima = espacio_id === 3 ? 7 : 8;
    // Permitir hasta 23:59 para bloqueos de todo el día
    const horaMaxima = 24;
    
    if (horaI < horaMinima || horaF > horaMaxima || horaI >= horaF) {
      return res.status(400).json({ error: `Horario inválido (${horaMinima}:00-${horaMaxima}:00)` });
    }

    const { data, error } = await supabase
      .from('bloqueos')
      .insert([{
        espacio_id,
        fecha,
        hora_inicio,
        hora_fin,
        motivo
      }])
      .select();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Ese horario ya está bloqueado' });
      }
      throw error;
    }

    res.json({ bloqueo: data[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/bloqueos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase
      .from('bloqueos')
      .delete()
      .eq('id', id);
    
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
