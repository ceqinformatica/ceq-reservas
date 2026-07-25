require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== UTILIDADES DE SEGURIDAD ==========

// Escapa entidades HTML para evitar inyección en emails (SEC-006)
function escapeHtml(texto) {
  if (texto === null || texto === undefined) return '';
  return String(texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Responde con un mensaje genérico al cliente y loguea el detalle real solo en el servidor (API-001).
// No exponer error.message crudo: puede filtrar nombres de tablas/columnas/constraints de Supabase.
function manejarError(res, error, mensajePublico = 'Error interno del servidor', status = 500) {
  console.error('❌ Error interno:', error);
  res.status(status).json({ error: mensajePublico });
}

// Valida que un valor sea un entero positivo (para IDs de path params) (API-003)
function esIdValido(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0;
}

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
// Email específico para avisos del espacio Frente (si no se configura, usa el general)
const EMAIL_MODERADOR_FRENTE = process.env.EMAIL_MODERADOR_FRENTE || EMAIL_MODERADOR;

// Devuelve el/los email(s) de moderador correspondientes según el espacio (para notificaciones internas).
// Altillo: solo el general. Frente: el general + el específico de Frente (sin duplicar si son iguales).
function getEmailModerador(espacio_id) {
  if (espacio_id === 3) {
    return [...new Set([EMAIL_MODERADOR, EMAIL_MODERADOR_FRENTE])];
  }
  return [EMAIL_MODERADOR];
}

// Contacto público que se muestra al reservante para consultas sobre Frente
const CONTACTO_EMAIL_FRENTE = 'Monsegonza511@gmail.com';
const CONTACTO_WHATSAPP_FRENTE = '595972753471'; // formato wa.me: código de país + número, sin +, espacios ni guiones

// Devuelve el HTML de la línea de contacto a mostrarle al usuario según el espacio.
// Frente: email de contacto + WhatsApp. Altillo: solo el email general del moderador.
function getContactoLineaHtml(espacio_id) {
  if (espacio_id === 3) {
    return `${CONTACTO_EMAIL_FRENTE} o por <a href="https://wa.me/${CONTACTO_WHATSAPP_FRENTE}">WhatsApp</a>`;
  }
  return `${EMAIL_MODERADOR}`;
}

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

// Cabeceras de seguridad (SEC-004). CSP queda deshabilitada por ahora: el frontend
// actual usa scripts y handlers inline (onclick=...) en varios lugares, y activar una
// CSP estricta sin antes extraer ese código a archivos separados rompería la UI.
// Pendiente: extraer JS inline de index.html/admin.html y activar contentSecurityPolicy.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

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

// ========== RATE LIMITING (AUTH-001, ABUSE-001) ==========

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Probá de nuevo en unos minutos.' }
});

const crearReservaLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Probá de nuevo más tarde.' }
});

const cancelarLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de cancelación. Probá de nuevo más tarde.' }
});

const reportesLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados reportes enviados. Probá de nuevo más tarde.' }
});

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
app.post('/api/login', loginLimiter, async (req, res) => {
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
    manejarError(res, error);
  }
});

// GET reservas (público, filtrado por espacio y fecha) — expone solo lo necesario
// para que los usuarios puedan corroborar sus propias reservas en el calendario público
// (nombre y motivo), pero NUNCA contacto ni código de cancelación (SEC-001/PRIV-001):
// antes se exponía select('*') completo, lo que permitía cancelar reservas ajenas
// usando el codigo_cancelacion filtrado por este mismo endpoint.
app.get('/api/reservas', async (req, res) => {
  try {
    const { espacio_id, fecha } = req.query;

    let query = supabase
      .from('reservas')
      .select('espacio_id, fecha, hora_inicio, hora_fin, nombre_solicitante, motivo')
      .eq('estado', 'activa');
    
    if (espacio_id) query = query.eq('espacio_id', parseInt(espacio_id));
    if (fecha) query = query.eq('fecha', fecha);
    
    const { data, error } = await query.limit(2000);
    
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    manejarError(res, error);
  }
});

// GET bloqueos (público)
app.get('/api/bloqueos', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bloqueos')
      .select('espacio_id, fecha, hora_inicio, hora_fin')
      .limit(1000);
    
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    manejarError(res, error);
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
    manejarError(res, error);
  }
});

// POST crear reserva
app.post('/api/reservas', crearReservaLimiter, async (req, res) => {
  try {
    const { espacio_id, nombre_solicitante, contacto, fecha, hora_inicio, hora_fin, motivo } = req.body;
    
    // Validar entrada
    if (!espacio_id || !nombre_solicitante || !contacto || !fecha || !hora_inicio || !hora_fin) {
      return res.status(400).json({ error: 'Faltan parámetros requeridos' });
    }

    // Longitudes máximas razonables (VAL-002)
    if (String(nombre_solicitante).length > 150 || String(contacto).length > 200 || (motivo && String(motivo).length > 500)) {
      return res.status(400).json({ error: 'Uno o más campos exceden la longitud permitida' });
    }

    // Solo se ofrecen públicamente los espacios Altillo (1) y Frente (3)
    const espacioIdNum = parseInt(espacio_id);
    if (![1, 3].includes(espacioIdNum)) {
      return res.status(400).json({ error: 'Espacio inválido' });
    }
    
    // Validar formato de hora
    if (!/^\d{2}:\d{2}$/.test(hora_inicio) || !/^\d{2}:\d{2}$/.test(hora_fin)) {
      return res.status(400).json({ error: 'Formato de hora inválido' });
    }

    const [horaIniH, horaIniM] = hora_inicio.split(':').map(Number);
    const [horaFinH, horaFinM] = hora_fin.split(':').map(Number);

    if (![horaIniH, horaIniM, horaFinH, horaFinM].every(Number.isFinite) ||
        horaIniH > 23 || horaFinH > 23 || horaIniM > 59 || horaFinM > 59) {
      return res.status(400).json({ error: 'Hora inválida' });
    }

    const inicioMin = horaIniH * 60 + horaIniM;
    const finMin = horaFinH * 60 + horaFinM;

    if (inicioMin >= finMin) {
      return res.status(400).json({ error: 'La hora de inicio debe ser anterior a la hora de fin' });
    }

    if (espacioIdNum === 3) {
      // Frente: solo se permiten los 3 turnos fijos (Desayuno, Almuerzo, Merienda).
      // No es una duración libre: Merienda dura 4hs, por eso no se valida como rango 1-3h.
      const turnosValidosFrente = [
        { inicio: '07:00', fin: '10:00' },
        { inicio: '10:00', fin: '13:00' },
        { inicio: '14:00', fin: '18:00' }
      ];
      const esTurnoValido = turnosValidosFrente.some(t => t.inicio === hora_inicio && t.fin === hora_fin);
      if (!esTurnoValido) {
        return res.status(400).json({ error: 'Turno inválido para Frente. Debe ser Desayuno (07-10), Almuerzo (10-13) o Merienda (14-18)' });
      }
    } else {
      // Altillo: selección libre de horas dentro del rango, entre 1 y 3 horas
      const duracionHoras = (finMin - inicioMin) / 60;
      if (duracionHoras < 1 || duracionHoras > 3) {
        return res.status(400).json({ error: 'La duración debe ser entre 1 y 3 horas' });
      }

      const horaMinimaPermitida = 8;
      if (horaIniH < horaMinimaPermitida || horaFinH > 18 || (horaFinH === 18 && horaFinM > 0)) {
        return res.status(400).json({ error: `Horario fuera de rango (${horaMinimaPermitida}:00-18:00)` });
      }
    }

    // Validar que la fecha esté dentro de la ventana permitida (hoy hasta hoy+31 días, sin fines de semana)
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    const fechaReserva = new Date(fecha + 'T00:00:00');
    const fechaLimite = new Date(hoy);
    fechaLimite.setDate(fechaLimite.getDate() + 31);

    const esFinDeSemana = fechaReserva.getDay() === 0 || fechaReserva.getDay() === 6;

    if (isNaN(fechaReserva.getTime()) || fechaReserva < hoy || fechaReserva > fechaLimite || esFinDeSemana) {
      return res.status(400).json({ error: 'Fecha fuera del rango permitido para reservar' });
    }

    // Verificar que no exista un bloqueo administrativo para ese espacio/fecha/horario (BUG-001).
    // Nota: esto reduce el riesgo pero no es 100% atómico frente a un bloqueo creado en el mismo instante;
    // la garantía definitiva requiere una función/transacción en la base (ver informe de auditoría, CONC-001).
    const { data: bloqueosConflicto, error: errorBloqueos } = await supabase
      .from('bloqueos')
      .select('hora_inicio, hora_fin')
      .eq('espacio_id', espacioIdNum)
      .eq('fecha', fecha);

    if (errorBloqueos) throw errorBloqueos;

    const hayBloqueo = (bloqueosConflicto || []).some(b => {
      const [bIniH, bIniM] = b.hora_inicio.split(':').map(Number);
      const [bFinH, bFinM] = b.hora_fin.split(':').map(Number);
      const bIniMin = bIniH * 60 + bIniM;
      const bFinMin = bFinH * 60 + bFinM;
      return inicioMin < bFinMin && finMin > bIniMin;
    });

    if (hayBloqueo) {
      return res.status(409).json({ error: 'El horario seleccionado está bloqueado por administración' });
    }
    
    // Generar código de cancelación seguro (16 caracteres)
    const codigo = crypto.randomBytes(8).toString('hex').toUpperCase();
    
    // Insertar reserva
    const { data: nuevaReserva, error } = await supabase
      .from('reservas')
      .insert([{
        espacio_id: espacioIdNum,
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
    const nombreEspacio = espaciosNombre[espacioIdNum];

    // Línea de contacto según el espacio reservado
    const contactoLinea = `<p>Ante cualquier consulta, contactate con: ${getContactoLineaHtml(espacioIdNum)}</p>`;

    // Valores escapados para uso en HTML de emails (SEC-006): nombre/motivo/contacto son
    // ingresados libremente por cualquier visitante y no deben interpretarse como HTML.
    const nombreSeguro = escapeHtml(nombre_solicitante);
    const motivoSeguro = escapeHtml(motivo);
    const contactoSeguro = escapeHtml(contacto);
    
    // Enviar email al usuario (si existe email)
    if (email) {
      await enviarEmail({
        to: email,
        subject: '✓ Confirmación de Reserva - CEQ',
        html: `
          <h2>¡Reserva Confirmada!</h2>
          <p>Hola ${nombreSeguro},</p>
          <p>Tu reserva ha sido confirmada exitosamente.</p>
          <hr>
          <p><strong>Detalles:</strong></p>
          <ul>
            <li><strong>Espacio:</strong> ${nombreEspacio}</li>
            <li><strong>Fecha:</strong> ${fecha}</li>
            <li><strong>Horario:</strong> ${hora_inicio} - ${hora_fin}</li>
            <li><strong>Motivo:</strong> ${motivoSeguro || 'Sin especificar'}</li>
            <li><strong>Código de cancelación:</strong> ${codigo}</li>
          </ul>
          <p>Si necesitas cancelar, usa tu código en: <a href="https://reservas.ceq-una.com/cancelar.html">Cancelar Reserva</a></p>
          ${contactoLinea}
          <p>Centro de Estudiantes de Química</p>
        `
      });
    }
    
    // Enviar email al moderador correspondiente (Altillo o Frente)
    await enviarEmail({
      to: getEmailModerador(espacioIdNum),
      subject: '📌 Nueva Reserva - CEQ',
      html: `
        <h2>Nueva Reserva</h2>
        <p><strong>Usuario:</strong> ${nombreSeguro}</p>
        <p><strong>Contacto:</strong> ${contactoSeguro}</p>
        <hr>
        <ul>
          <li><strong>Espacio:</strong> ${nombreEspacio}</li>
          <li><strong>Fecha:</strong> ${fecha}</li>
          <li><strong>Horario:</strong> ${hora_inicio} - ${hora_fin}</li>
          <li><strong>Motivo:</strong> ${motivoSeguro || 'Sin especificar'}</li>
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
    manejarError(res, error);
  }
});

// Cancelar por código (público)
app.post('/api/cancelar-por-codigo', cancelarLimiter, async (req, res) => {
  try {
    const { codigo } = req.body;
    
    if (!codigo || typeof codigo !== 'string' || codigo.length > 64) {
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
      const emailUsuario = reserva.contacto.split('|')[1]?.trim();
      if (emailUsuario) {
        await enviarEmail({
          to: emailUsuario,
          subject: 'Período de Cancelación Gratuita Finalizado - CEQ',
          html: `
            <h2>El período de cancelación gratuita ha finalizado</h2>
            <p>Intentaste cancelar tu reserva de <strong>${getEspacioNombre(reserva.espacio_id)}</strong>, pero el período de cancelación gratuita ya venció.</p>
            <p><strong>Detalles de la Reserva:</strong></p>
            <ul>
              <li>Fecha: ${reserva.fecha}</li>
              <li>Horario: ${reserva.hora_inicio.substring(0,5)} - ${reserva.hora_fin.substring(0,5)}</li>
            </ul>
            <p>Si de todas formas deseás realizar la cancelación, contactate por WhatsApp: <a href="https://wa.me/595972753471">Contactar por WhatsApp</a></p>
          `
        });
      }

      // Aviso al moderador: hubo un intento de cancelación fuera del período gratuito
      await enviarEmail({
        to: getEmailModerador(reserva.espacio_id),
        subject: 'Intento de Cancelación Fuera de Plazo - CEQ',
        html: `
          <h2>Intento de Cancelación (Período Vencido)</h2>
          <p><strong>Usuario:</strong> ${escapeHtml(reserva.nombre_solicitante)}</p>
          <p><strong>Contacto:</strong> ${escapeHtml(reserva.contacto)}</p>
          <p><strong>Espacio:</strong> ${getEspacioNombre(reserva.espacio_id)}</p>
          <p><strong>Fecha de la reserva:</strong> ${reserva.fecha}</p>
          <p><strong>Horario:</strong> ${reserva.hora_inicio.substring(0,5)} - ${reserva.hora_fin.substring(0,5)}</p>
          <p>El usuario intentó cancelar esta reserva, pero el período de cancelación gratuita ya había vencido. La reserva sigue activa.</p>
        `
      });

      return res.status(403).json({ 
        error: 'EL PERIODO DE CANCELACION GRATUITA HA FINALIZADO. SI DESEA REALIZAR LA CANCELACION CONTACTESE CON ceq.informatica@gmail.com' 
      });
    }
    
    // Actualizar estado de forma condicional y atómica (BUG-005): solo transiciona si
    // seguía activa en ese instante. Si otra petición concurrente ya la canceló,
    // updateData viene vacío y respondemos de forma idempotente sin reenviar emails.
    const { data: updateData, error: updateError } = await supabase
      .from('reservas')
      .update({ estado: 'cancelada' })
      .eq('codigo_cancelacion', codigo)
      .eq('estado', 'activa')
      .select();
    
    if (updateError) throw updateError;

    if (!updateData || updateData.length === 0) {
      return res.json({ mensaje: 'La reserva ya se encontraba cancelada' });
    }

    // Enviar emails (PRIV-002 corregido: el contacto de Frente ya no se copia en
    // el email del propio usuario; solo se le muestra como texto de contacto)
    const email = reserva.contacto.split('|')[1]?.trim();
    if (email) {
      await enviarEmail({
        to: email,
        subject: 'Cancelación Confirmada - CEQ Reservas',
        html: `
          <h2>¡Has cancelado correctamente tu reserva!</h2>
          <p><strong>Detalles:</strong></p>
          <ul>
            <li>Fecha: ${reserva.fecha}</li>
            <li>Espacio: ${getEspacioNombre(reserva.espacio_id)}</li>
            <li>Horario: ${reserva.hora_inicio.substring(0,5)} - ${reserva.hora_fin.substring(0,5)}</li>
          </ul>
          <p>Si tienes dudas, contacta con: ${getContactoLineaHtml(reserva.espacio_id)}</p>
        `
      });
    }

    // Email al moderador (solo para autocancelaciones del espacio Frente)
    if (reserva.espacio_id === 3) {
      await enviarEmail({
        to: getEmailModerador(reserva.espacio_id),
        subject: 'Cancelación de Reserva - CEQ',
        html: `
          <h2>Reserva Cancelada por Usuario</h2>
          <p><strong>Usuario:</strong> ${escapeHtml(reserva.nombre_solicitante)}</p>
          <p><strong>Contacto:</strong> ${escapeHtml(reserva.contacto)}</p>
          <p><strong>Espacio:</strong> ${getEspacioNombre(reserva.espacio_id)}</p>
          <p><strong>Fecha:</strong> ${reserva.fecha}</p>
          <p><strong>Horario:</strong> ${reserva.hora_inicio.substring(0,5)} - ${reserva.hora_fin.substring(0,5)}</p>
        `
      });
    }

    res.json({ 
      mensaje: 'Reserva cancelada correctamente',
      reserva_id: reserva.id,
      espacio_id: reserva.espacio_id,
      fecha: reserva.fecha
    });
  } catch (error) {
    manejarError(res, error);
  }
});

// Reportar error (público)
app.post('/api/reportes', reportesLimiter, async (req, res) => {
  try {
    const { mensaje, url, navegador } = req.body;
    
    if (!mensaje || typeof mensaje !== 'string') {
      return res.status(400).json({ error: 'Mensaje requerido' });
    }

    if (mensaje.length > 1000 || (url && String(url).length > 500) || (navegador && String(navegador).length > 300)) {
      return res.status(400).json({ error: 'Uno o más campos exceden la longitud permitida' });
    }

    if (url && !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: 'URL inválida' });
    }
    
    const { error } = await supabase
      .from('reportes_errores')
      .insert([{ mensaje, url, navegador, leido: false }]);
    
    if (error) throw error;
    return res.status(201).json({ mensaje: 'Reporte enviado correctamente' });
  } catch (error) {
    return manejarError(res, error);
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
    manejarError(res, error);
  }
});

// GET bloqueos completos para el panel de admin (incluye id y motivo, a diferencia
// del endpoint público /api/bloqueos que solo expone lo necesario para pintar el calendario)
app.get('/api/admin/bloqueos', verifyAdminToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bloqueos')
      .select('*')
      .order('fecha', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    manejarError(res, error);
  }
});

// POST crear bloqueo
app.post('/api/bloqueos', verifyAdminToken, async (req, res) => {
  try {
    const { espacio_id, fecha, hora_inicio, hora_fin, motivo } = req.body;
    
    if (!espacio_id || !fecha || !hora_inicio || !hora_fin) {
      return res.status(400).json({ error: 'Faltan parámetros' });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || isNaN(new Date(fecha + 'T00:00:00').getTime())) {
      return res.status(400).json({ error: 'Fecha inválida' });
    }

    if (!/^\d{2}:\d{2}$/.test(hora_inicio) || !/^\d{2}:\d{2}$/.test(hora_fin)) {
      return res.status(400).json({ error: 'Formato de hora inválido' });
    }
    
    const [horaI, minI] = hora_inicio.split(':').map(Number);
    const [horaF, minF] = hora_fin.split(':').map(Number);

    if (![horaI, minI, horaF, minF].every(Number.isFinite) || horaI > 23 || horaF > 23 || minI > 59 || minF > 59) {
      return res.status(400).json({ error: 'Hora inválida' });
    }
    
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
        motivo: motivo ? String(motivo).slice(0, 300) : 'Sin especificar'
      }]);
    
    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Ya existe un bloqueo para ese horario' });
      }
      throw error;
    }
    
    res.status(201).json({ mensaje: 'Bloqueo creado' });
  } catch (error) {
    manejarError(res, error);
  }
});

// DELETE bloqueo
app.delete('/api/bloqueos/:id', verifyAdminToken, async (req, res) => {
  try {
    const { id } = req.params;

    if (!esIdValido(id)) {
      return res.status(400).json({ error: 'ID inválido' });
    }
    
    const { data, error } = await supabase
      .from('bloqueos')
      .delete()
      .eq('id', id)
      .select();
    
    if (error) throw error;
    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Bloqueo no encontrado' });
    }
    res.json({ mensaje: 'Bloqueo eliminado' });
  } catch (error) {
    manejarError(res, error);
  }
});

// POST cancelar reserva (admin)
app.post('/api/admin/cancelar/:reserva_id', verifyAdminToken, async (req, res) => {
  try {
    const { reserva_id } = req.params;
    const { motivo } = req.body;

    if (!esIdValido(reserva_id)) {
      return res.status(400).json({ error: 'ID inválido' });
    }

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

    if (reserva.estado !== 'activa') {
      return res.json({ mensaje: 'La reserva ya se encontraba cancelada' });
    }
    
    // Transición condicional (BUG-005): solo cancela si seguía activa
    const { data: updateData, error } = await supabase
      .from('reservas')
      .update({ estado: 'cancelada' })
      .eq('id', reserva_id)
      .eq('estado', 'activa')
      .select();
    
    if (error) throw error;

    if (!updateData || updateData.length === 0) {
      return res.json({ mensaje: 'La reserva ya se encontraba cancelada' });
    }

    // Enviar email al reservante con motivo (PRIV-002 corregido: ya no se copia
    // al contacto de Frente en el email del propio usuario)
    const email = reserva.contacto.split('|')[1]?.trim();
    if (email) {
      await enviarEmail({
        to: email,
        subject: 'Tu Reserva Fue Cancelada por el Moderador - CEQ',
        html: `
          <h2>Tu reserva fue cancelada por el moderador</h2>
          <p><strong>Motivo:</strong> ${escapeHtml(motivo) || 'No especificado'}</p>
          <p><strong>Detalles de la Reserva:</strong></p>
          <ul>
            <li>Fecha: ${reserva.fecha}</li>
            <li>Espacio: ${getEspacioNombre(reserva.espacio_id)}</li>
            <li>Horario: ${reserva.hora_inicio.substring(0,5)} - ${reserva.hora_fin.substring(0,5)}</li>
          </ul>
          <p>Si tienes preguntas, contacta con: ${getContactoLineaHtml(reserva.espacio_id)}</p>
        `
      });
    }

    res.json({ mensaje: 'Reserva cancelada por admin' });
  } catch (error) {
    manejarError(res, error);
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
    manejarError(res, error);
  }
});

// POST marcar reporte como leído
app.post('/api/admin/reportes/:id/leer', verifyAdminToken, async (req, res) => {
  try {
    const { id } = req.params;

    if (!esIdValido(id)) {
      return res.status(400).json({ error: 'ID inválido' });
    }
    
    const { data, error } = await supabase
      .from('reportes_errores')
      .update({ leido: true })
      .eq('id', id)
      .select();
    
    if (error) throw error;
    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Reporte no encontrado' });
    }
    res.json({ mensaje: 'Reporte marcado como leído' });
  } catch (error) {
    manejarError(res, error);
  }
});

// GET estadísticas
app.get('/api/estadisticas', async (req, res) => {
  try {
    const { count: activas, error: errorActivas } = await supabase
      .from('reservas')
      .select('id', { count: 'exact', head: true })
      .eq('estado', 'activa');

    if (errorActivas) throw errorActivas;

    const { count: canceladas, error: errorCanceladas } = await supabase
      .from('reservas')
      .select('id', { count: 'exact', head: true })
      .eq('estado', 'cancelada');

    if (errorCanceladas) throw errorCanceladas;
    
    res.json({
      reservas_activas: activas || 0,
      reservas_canceladas: canceladas || 0
    });
  } catch (error) {
    manejarError(res, error);
  }
});

// ========== INICIAR SERVIDOR ==========

app.listen(PORT, () => {
  console.log(`✅ Servidor corriendo en puerto ${PORT}`);
  console.log(`🔒 Modo seguro: JWT, bcrypt y validaciones activadas`);
});
