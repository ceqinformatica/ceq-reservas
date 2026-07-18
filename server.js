require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== CONFIGURACIÓN DE SEGURIDAD ==========

// Verificar que todas las variables de entorno necesarias están presentes
const requiredEnvVars = ['SUPABASE_URL', 'SUPABASE_KEY', 'BREVO_API_KEY', 'JWT_SECRET', 'ADMIN_PASSWORD_HASH'];
requiredEnvVars.forEach(varName => {
  if (!process.env[varName]) {
    console.error(`❌ ERROR: Variable de entorno ${varName} no configurada`);
    process.exit(1);
  }
});

// Configuración Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Configuración Brevo (envío de emails)
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const EMAIL_MODERADOR = process.env.EMAIL_MODERADOR || 'ceq.informatica@gmail.com';

// Función helper para enviar emails vía la API de Brevo
async function enviarEmail({ to, subject, html }) {
  try {
    const destinatarios = Array.isArray(to) ? to : [to];
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': BREVO_API_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: 'CEQ Reservas', email: 'reservas@ceq-una.com' },
        to: destinatarios.map(email => ({ email })),
        subject,
        htmlContent: html
      })
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      console.error('⚠️ Error al enviar email vía Brevo:', res.status, errorData);
      return false;
    }
    return true;
  } catch (err) {
    console.error('⚠️ Error de red al enviar email:', err);
    return false;
  }
}

// Configuración de seguridad
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;

// ========== MIDDLEWARE ==========

// CORS configurado correctamente
app.use(cors({
  origin: [
    'https://ceq-reservas-frontend-pink.vercel.app',
    'https://reservas.ceq-una.com',
    'http://localhost:3000',
    'http://localhost:5173'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'DELETE', 'PUT'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Limitar tamaño de payloads
app.use(express.json({ limit: '10kb' }));

// ========== UTILIDADES ==========

function getEspacioNombre(id) {
  const espacios = { 1: 'Altillo', 2: 'Sala de Reuniones', 3: 'Frente' };
  return espacios[id] || 'Espacio ' + id;
}

// Middleware de autenticación JWT
const verifyAdminToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    return res.status(401).json({ error: 'Token requerido' });
  }
  
  const token = authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Formato de token inválido' });
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expirado' });
    }
    return res.status(403).json({ error: 'Token inválido' });
  }
};

// ========== ENDPOINTS PÚBLICOS ==========

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// LOGIN - Endpoint seguro
app.post('/api/login', async (req, res) => {
  try {
    const { password } = req.body;
    
    if (!password) {
      return res.status(400).json({ error: 'Contraseña requerida' });
    }
    
    // Validar contraseña
    const passwordValida = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
    
    if (!passwordValida) {
      console.warn(`⚠️ Intento de login fallido a las ${new Date().toISOString()}`);
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }
    
    // Generar JWT (válido por 8 horas)
    const token = jwt.sign(
      { adminId: 'admin', timestamp: Date.now() },
      JWT_SECRET,
      { expiresIn: '8h' }
    );
    
    console.log(`✅ Login exitoso a las ${new Date().toISOString()}`);
    res.json({ 
      token, 
      mensaje: 'Sesión iniciada correctamente',
      expiresIn: '8h'
    });
  } catch (error) {
    console.error('❌ Error en login:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// GET espacios
app.get('/api/espacios', async (req, res) => {
  try {
    const { data } = await supabase.from('espacios').select('*');
    res.json(data || []);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// GET reservas (público, filtrado por espacio y fecha)
app.get('/api/reservas', async (req, res) => {
  try {
    const { espacio_id, fecha } = req.query;
    
    let query = supabase
      .from('reservas')
      .select('*')
      .eq('estado', 'activa');
    
    if (espacio_id) query = query.eq('espacio_id', parseInt(espacio_id));
    if (fecha) query = query.eq('fecha', fecha);
    
    const { data, error } = await query;
    
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// GET bloqueos (público)
app.get('/api/bloqueos', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bloqueos')
      .select('*');
    
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// Validar disponibilidad (público)
app.post('/api/validar-disponibilidad', async (req, res) => {
  try {
    const { espacio_id, fecha, hora_inicio, hora_fin } = req.body;
    
    if (!espacio_id || !fecha || !hora_inicio || !hora_fin) {
      return res.status(400).json({ error: 'Faltan parámetros' });
    }
    
    // Buscar conflictos
    const { data, error } = await supabase
      .from('reservas')
      .select('*')
      .eq('espacio_id', espacio_id)
      .eq('fecha', fecha)
      .eq('estado', 'activa');
    
    if (error) throw error;
    
    const hayConflicto = data.some(r => {
      const rStart = parseInt(r.hora_inicio.split(':')[0]);
      const rEnd = parseInt(r.hora_fin.split(':')[0]);
      const hStart = parseInt(hora_inicio.split(':')[0]);
      const hEnd = parseInt(hora_fin.split(':')[0]);
      return !(rEnd <= hStart || rStart >= hEnd);
    });
    
    res.json({ disponible: !hayConflicto });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// POST crear reserva
app.post('/api/reservas', async (req, res) => {
  try {
    const { espacio_id, nombre_solicitante, contacto, fecha, hora_inicio, hora_fin, motivo } = req.body;
    
    // Validar entrada
    if (!espacio_id || !nombre_solicitante || !contacto || !fecha || !hora_inicio || !hora_fin) {
      return res.status(400).json({ error: 'Faltan parámetros requeridos' });
    }
    
    // Validar formato de hora
    if (!/^\d{2}:\d{2}$/.test(hora_inicio) || !/^\d{2}:\d{2}$/.test(hora_fin)) {
      return res.status(400).json({ error: 'Formato de hora inválido' });
    }

    // Validar que la fecha esté dentro de la ventana permitida (hoy hasta hoy+5 días, sin fines de semana)
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    const fechaReserva = new Date(fecha + 'T00:00:00');
    const fechaLimite = new Date(hoy);
    fechaLimite.setDate(fechaLimite.getDate() + 5);

    const esFinDeSemana = fechaReserva.getDay() === 0 || fechaReserva.getDay() === 6;

    if (fechaReserva < hoy || fechaReserva > fechaLimite || esFinDeSemana) {
      return res.status(400).json({ error: 'Fecha fuera del rango permitido para reservar' });
    }
    
    // Generar código de cancelación seguro (16 caracteres)
    const codigo = crypto.randomBytes(8).toString('hex').toUpperCase();
    
    // Insertar reserva
    const { data: nuevaReserva, error } = await supabase
      .from('reservas')
      .insert([{
        espacio_id,
        nombre_solicitante,
        contacto,
        fecha,
        hora_inicio: hora_inicio + ':00',
        hora_fin: hora_fin + ':00',
        estado: 'activa',
        motivo: motivo || '',
        codigo_cancelacion: codigo
      }])
      .select();
    
    if (error) {
      if (error.code === '23505' || error.code === '23P01') {
        return res.status(409).json({ error: 'Horario no disponible - se solapa con otra reserva existente' });
      }
      throw error;
    }
    
    // Extraer email del contacto (formato: "celular | email")
    const email = contacto.split('|')[1]?.trim() || '';
    const espaciosNombre = { 1: 'Altillo', 2: 'Sala de Reuniones', 3: 'Frente' };
    const nombreEspacio = espaciosNombre[espacio_id];
    
    // Enviar email al usuario (si existe email)
    if (email) {
      await enviarEmail({
        to: email,
        subject: '✓ Confirmación de Reserva - CEQ',
        html: `
          <h2>¡Reserva Confirmada!</h2>
          <p>Hola ${nombre_solicitante},</p>
          <p>Tu reserva ha sido confirmada exitosamente.</p>
          <hr>
          <p><strong>Detalles:</strong></p>
          <ul>
            <li><strong>Espacio:</strong> ${nombreEspacio}</li>
            <li><strong>Fecha:</strong> ${fecha}</li>
            <li><strong>Horario:</strong> ${hora_inicio} - ${hora_fin}</li>
            <li><strong>Motivo:</strong> ${motivo || 'Sin especificar'}</li>
            <li><strong>Código de cancelación:</strong> ${codigo}</li>
          </ul>
          <p>Si necesitas cancelar, usa tu código en: <a href="https://reservas.ceq-una.com/cancelar.html">Cancelar Reserva</a></p>
          <p>Centro de Estudiantes de Química</p>
        `
      });
    }
    
    // Enviar email al moderador
    await enviarEmail({
      to: EMAIL_MODERADOR,
      subject: '📌 Nueva Reserva - CEQ',
      html: `
        <h2>Nueva Reserva</h2>
        <p><strong>Usuario:</strong> ${nombre_solicitante}</p>
        <p><strong>Contacto:</strong> ${contacto}</p>
        <hr>
        <ul>
          <li><strong>Espacio:</strong> ${nombreEspacio}</li>
          <li><strong>Fecha:</strong> ${fecha}</li>
          <li><strong>Horario:</strong> ${hora_inicio} - ${hora_fin}</li>
          <li><strong>Motivo:</strong> ${motivo || 'Sin especificar'}</li>
          <li><strong>Código:</strong> ${codigo}</li>
        </ul>
      `
    });
    
    res.status(201).json({
      mensaje: 'Reserva creada exitosamente',
      reserva: nuevaReserva[0],
      codigo
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// Cancelar por código (público)
app.post('/api/cancelar-por-codigo', async (req, res) => {
  try {
    const { codigo } = req.body;
    
    if (!codigo) {
      return res.status(400).json({ error: 'Código requerido' });
    }
    
    const { data, error } = await supabase
      .from('reservas')
      .select('*')
      .eq('codigo_cancelacion', codigo)
      .eq('estado', 'activa');
    
    if (error) throw error;
    if (data.length === 0) {
      return res.status(404).json({ error: 'Código no válido' });
    }

    const reserva = data[0];
    const fechaReserva = new Date(reserva.fecha);
    const hoy = new Date();
    const diferenciaDias = Math.floor((fechaReserva - hoy) / (1000 * 60 * 60 * 24));

    // Validar período de cancelación para Frente (2 días)
    if (reserva.espacio_id === 3 && diferenciaDias < 2) {
      return res.status(403).json({ 
        error: 'EL PERIODO DE CANCELACION GRATUITA HA FINALIZADO. SI DESEA REALIZAR LA CANCELACION CONTACTESE CON ceq.informatica@gmail.com' 
      });
    }
    
    // Actualizar estado
    const { error: updateError } = await supabase
      .from('reservas')
      .update({ estado: 'cancelada' })
      .eq('codigo_cancelacion', codigo);
    
    if (updateError) throw updateError;

    // Enviar emails
    const email = reserva.contacto.split('|')[1]?.trim();
    if (email) {
      await enviarEmail({
        to: email,
        subject: 'Cancelación Confirmada - CEQ Reservas',
        html: `
          <h2>Reserva Cancelada</h2>
          <p>Tu reserva ha sido cancelada correctamente.</p>
          <p><strong>Detalles:</strong></p>
          <ul>
            <li>Fecha: ${reserva.fecha}</li>
            <li>Espacio: ${getEspacioNombre(reserva.espacio_id)}</li>
            <li>Horario: ${reserva.hora_inicio.substring(0,5)} - ${reserva.hora_fin.substring(0,5)}</li>
          </ul>
          <p>Si tienes dudas, contacta con: ${EMAIL_MODERADOR}</p>
        `
      });
    }

    // Email al moderador
    await enviarEmail({
      to: EMAIL_MODERADOR,
      subject: 'Cancelación de Reserva - CEQ',
      html: `
        <h2>Reserva Cancelada por Usuario</h2>
        <p><strong>Usuario:</strong> ${reserva.nombre_solicitante}</p>
        <p><strong>Contacto:</strong> ${reserva.contacto}</p>
        <p><strong>Espacio:</strong> ${getEspacioNombre(reserva.espacio_id)}</p>
        <p><strong>Fecha:</strong> ${reserva.fecha}</p>
        <p><strong>Horario:</strong> ${reserva.hora_inicio.substring(0,5)} - ${reserva.hora_fin.substring(0,5)}</p>
      `
    });

    res.json({ 
      mensaje: 'Reserva cancelada correctamente',
      reserva_id: reserva.id,
      espacio_id: reserva.espacio_id,
      fecha: reserva.fecha
    });
  } catch (error) {
    console.error('❌ Error en cancelación:', error);
    res.status(500).json({ error: error.message });
  }
});

// Reportar error (público)
app.post('/api/reportes', async (req, res) => {
  try {
    const { mensaje, url, navegador } = req.body;
    
    if (!mensaje) {
      return res.status(400).json({ error: 'Mensaje requerido' });
    }
    
    const { error } = await supabase
      .from('reportes_errores')
      .insert([{ mensaje, url, navegador, leido: false }]);
    
    if (error) throw error;
    return res.status(201).json({ mensaje: 'Reporte enviado correctamente' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  }
});

// ========== ENDPOINTS PROTEGIDOS (REQUIEREN JWT) ==========

// GET admin/reservas
app.get('/api/admin/reservas', verifyAdminToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('reservas')
      .select('*')
      .order('fecha', { ascending: false });
    
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// POST crear bloqueo
app.post('/api/bloqueos', verifyAdminToken, async (req, res) => {
  try {
    const { espacio_id, fecha, hora_inicio, hora_fin, motivo } = req.body;
    
    if (!espacio_id || !fecha || !hora_inicio || !hora_fin) {
      return res.status(400).json({ error: 'Faltan parámetros' });
    }
    
    const [horaI, minI] = hora_inicio.split(':').map(Number);
    const [horaF, minF] = hora_fin.split(':').map(Number);
    
    const isBloqueCompleto = horaI === 0 && minI === 0 && horaF === 23 && minF === 59;
    
    if (!isBloqueCompleto) {
      const horaMinima = espacio_id === 3 ? 7 : 8;
      const horaMaxima = 18;
      
      if (horaI < horaMinima || horaF > horaMaxima || horaI >= horaF) {
        return res.status(400).json({ error: `Horario inválido (${horaMinima}:00-${horaMaxima}:00)` });
      }
    }
    
    const { error } = await supabase
      .from('bloqueos')
      .insert([{
        espacio_id,
        fecha,
        hora_inicio,
        hora_fin,
        motivo: motivo || 'Sin especificar'
      }]);
    
    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Ya existe un bloqueo para ese horario' });
      }
      throw error;
    }
    
    res.status(201).json({ mensaje: 'Bloqueo creado' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE bloqueo
app.delete('/api/bloqueos/:id', verifyAdminToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const { error } = await supabase
      .from('bloqueos')
      .delete()
      .eq('id', id);
    
    if (error) throw error;
    res.json({ mensaje: 'Bloqueo eliminado' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// POST cancelar reserva (admin)
app.post('/api/admin/cancelar/:reserva_id', verifyAdminToken, async (req, res) => {
  try {
    const { reserva_id } = req.params;
    const { motivo } = req.body;

    // Obtener datos de la reserva
    const { data, error: selectError } = await supabase
      .from('reservas')
      .select('*')
      .eq('id', reserva_id);

    if (selectError) throw selectError;
    if (data.length === 0) {
      return res.status(404).json({ error: 'Reserva no encontrada' });
    }

    const reserva = data[0];
    
    const { error } = await supabase
      .from('reservas')
      .update({ estado: 'cancelada' })
      .eq('id', reserva_id);
    
    if (error) throw error;

    // Enviar email al reservante con motivo
    const email = reserva.contacto.split('|')[1]?.trim();
    if (email) {
      await enviarEmail({
        to: email,
        subject: 'Cancelación de Reserva - CEQ',
        html: `
          <h2>Tu Reserva Ha Sido Cancelada</h2>
          <p><strong>Motivo:</strong> ${motivo || 'No especificado'}</p>
          <p><strong>Detalles de la Reserva:</strong></p>
          <ul>
            <li>Fecha: ${reserva.fecha}</li>
            <li>Espacio: ${getEspacioNombre(reserva.espacio_id)}</li>
            <li>Horario: ${reserva.hora_inicio.substring(0,5)} - ${reserva.hora_fin.substring(0,5)}</li>
          </ul>
          <p>Si tienes preguntas, contacta con: ${EMAIL_MODERADOR}</p>
        `
      });
    }

    res.json({ mensaje: 'Reserva cancelada por admin' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// GET reportes
app.get('/api/admin/reportes', verifyAdminToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('reportes_errores')
      .select('*')
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// POST marcar reporte como leído
app.post('/api/admin/reportes/:id/leer', verifyAdminToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const { error } = await supabase
      .from('reportes_errores')
      .update({ leido: true })
      .eq('id', id);
    
    if (error) throw error;
    res.json({ mensaje: 'Reporte marcado como leído' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// GET estadísticas
app.get('/api/estadisticas', async (req, res) => {
  try {
    const { data: activas } = await supabase
      .from('reservas')
      .select('id')
      .eq('estado', 'activa');
    
    const { data: canceladas } = await supabase
      .from('reservas')
      .select('id')
      .eq('estado', 'cancelada');
    
    res.json({
      reservas_activas: activas?.length || 0,
      reservas_canceladas: canceladas?.length || 0
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// ========== INICIAR SERVIDOR ==========

app.listen(PORT, () => {
  console.log(`✅ Servidor corriendo en puerto ${PORT}`);
  console.log(`🔒 Modo seguro: JWT, bcrypt y validaciones activadas`);
});
