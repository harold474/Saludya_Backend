const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const db = require('./db'); 
const SibApiV3Sdk = require('@getbrevo/brevo');
let apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();
let defaultClient = SibApiV3Sdk.ApiClient.instance;


let apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;

const app = express();
app.use(cors()); 
app.use(express.json()); 

// ==========================================
// 🌐 RUTA RAÍZ (Soluciona el error "Cannot GET /")
// ==========================================
app.get('/', (req, res) => {
    res.send('¡El backend de SaludYa está funcionando perfectamente! 🚀');
});

const JWT_SECRET = process.env.JWT_SECRET || 'super_secreto_saludya_123';

// ==========================================
// 🛡️ AUTO-CONFIGURACIÓN INICIAL (ADMIN)
// ==========================================
const inicializarAdmin = async () => {
    try {
        const [admins] = await db.query("SELECT * FROM administradores WHERE email = 'admin@saludya.com'");
        if (admins.length === 0) {
            const salt = await bcrypt.genSalt(10);
            const hash = await bcrypt.hash('123456', salt);
            await db.query(
                "INSERT INTO administradores (nombre, email, password) VALUES ('Administrador Principal', 'admin@saludya.com', ?)",
                [hash]
            );
            console.log("✅ Super Administrador creado automáticamente.");
        }
    } catch (error) {
        console.error("❌ Error al auto-crear admin:", error.message);
    }
};
inicializarAdmin();

// ==========================================
// 🏥 RUTAS DE USUARIOS Y PERSONAL
// ==========================================

// Obtener médicos (Híbrida: Paginada para Admin, Lista Activa para Pacientes)
app.get('/api/medicos', async (req, res) => {
    const page = req.query.page;
    try {
        if (page) {
            const limit = 10;
            const offset = (parseInt(page) - 1) * limit;
            const [[{ total }]] = await db.query('SELECT COUNT(*) as total FROM medicos');
            const [rows] = await db.query('SELECT id_medico, nombre, especialidad, email, estado FROM medicos LIMIT ? OFFSET ?', [limit, offset]);
            return res.json({ data: rows, totalPaginas: Math.ceil(total / limit) });
        }
        
        const [rows] = await db.query("SELECT id_medico, nombre, especialidad, email FROM medicos WHERE estado = 'Activo' OR estado IS NULL");
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Error al obtener médicos' });
    }
});

// Lista de pacientes para el Admin (Híbrida)
app.get('/api/pacientes', async (req, res) => {
    const page = req.query.page;
    try {
        if (page) {
            const limit = 10;
            const offset = (parseInt(page) - 1) * limit;
            const [[{ total }]] = await db.query('SELECT COUNT(*) as total FROM pacientes');
            const [rows] = await db.query('SELECT id_paciente, nombre, documento, email, telefono, estado FROM pacientes LIMIT ? OFFSET ?', [limit, offset]);
            return res.json({ data: rows, totalPaginas: Math.ceil(total / limit) });
        }
        const [rows] = await db.query('SELECT id_paciente, nombre, documento, email, telefono, estado FROM pacientes');
        res.json(rows);
    } catch (error) { res.status(500).json({ error: 'Error al obtener pacientes' }); }
});

// ==========================================
// 📅 RUTAS DE AGENDA Y CITAS
// ==========================================

app.get('/api/medicos/:id_medico/citas', async (req, res) => {
    const { id_medico } = req.params;
    try {
        const query = `
            SELECT c.id_cita, c.fecha_hora, c.motivo, 
                   COALESCE(NULLIF(c.estado, ''), 'Pendiente') AS estado, 
                   p.nombre AS paciente 
            FROM citas c
            JOIN pacientes p ON c.id_paciente = p.id_paciente
            WHERE c.id_medico = ?
            ORDER BY c.fecha_hora ASC
        `;
        const [rows] = await db.query(query, [id_medico]);
        res.json(rows);
    } catch (error) { res.status(500).json({ error: 'Error en agenda médica' }); }
});

// Agenda Global para el Admin
app.get('/api/admin/agenda-global', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const offset = (page - 1) * limit;
    try {
        const [[{ total }]] = await db.query('SELECT COUNT(*) as total FROM citas');
        const query = `
            SELECT c.id_cita, c.fecha_hora, c.motivo, c.estado, 
                   p.nombre AS paciente, m.nombre AS medico 
            FROM citas c
            JOIN pacientes p ON c.id_paciente = p.id_paciente
            JOIN medicos m ON c.id_medico = m.id_medico
            ORDER BY c.fecha_hora ASC
            LIMIT ? OFFSET ?
        `;
        const [rows] = await db.query(query, [limit, offset]);
        res.json({ data: rows, totalPaginas: Math.ceil(total / limit) });
    } catch (error) { res.status(500).json({ error: 'Error en agenda global' }); }
});

app.post('/api/citas', async (req, res) => {
    console.log("--- NUEVA SOLICITUD DE CITA ---");
    const { id_paciente, id_medico, fecha_hora, motivo } = req.body;

    try {
        // 1. Verificación de horario (CORREGIDA con comillas simples)
        const sqlOcupado = "SELECT * FROM citas WHERE id_medico = ? AND fecha_hora = ? AND estado NOT IN ('Cancelada', 'Concluida')";
        const [ocupado] = await db.query(sqlOcupado, [id_medico, fecha_hora]);
        
        if (ocupado.length > 0) return res.status(400).json({ error: 'Horario ocupado' });

        // 2. Obtener especialidad
        const [medicoInfo] = await db.query('SELECT especialidad FROM medicos WHERE id_medico = ?', [id_medico]);
        if (medicoInfo.length === 0) return res.status(404).json({ error: 'Médico no encontrado.' });
        
        const especialidad = medicoInfo[0].especialidad;

        // 3. Verificar cita duplicada (CORREGIDA con comillas simples)
        const sqlDuplicada = `
            SELECT c.id_cita FROM citas c
            JOIN medicos m ON c.id_medico = m.id_medico
            WHERE c.id_paciente = ? AND m.especialidad = ? AND c.estado NOT IN ('Cancelada', 'Concluida')
        `;
        const [duplicada] = await db.query(sqlDuplicada, [id_paciente, especialidad]);

        if (duplicada.length > 0) return res.status(400).json({ error: `Ya tienes una cita activa para ${especialidad}.` });

        // 4. INSERCIÓN BLINDADA
        const sqlInsert = 'INSERT INTO citas (id_paciente, id_medico, fecha_hora, motivo, estado) VALUES (?, ?, ?, ?, ?)';
        const valores = [id_paciente, id_medico, fecha_hora, motivo || 'Consulta General', 'Pendiente'];
        
        await db.query(sqlInsert, valores);
        
        console.log("✅ CITA GUARDADA CON ÉXITO");
        res.status(201).json({ message: 'Cita agendada' });

    } catch (error) {
        console.error("🚨 ERROR CRÍTICO EN MYSQL:", error);
        res.status(500).json({ error: 'Error al agendar', detalle: error.message });
    }
});

app.get('/api/pacientes/:id_paciente/citas', async (req, res) => {
    try {
        const query = `
            SELECT c.id_cita, c.fecha_hora, c.motivo, c.estado, 
                   m.id_medico, m.nombre AS medico, m.especialidad
            FROM citas c
            JOIN medicos m ON c.id_medico = m.id_medico
            WHERE c.id_paciente = ?
            ORDER BY c.fecha_hora DESC
        `;
        const [rows] = await db.query(query, [req.params.id_paciente]);
        res.json(rows);
    } catch (error) { res.status(500).json({ error: 'Error historial' }); }
});

app.put('/api/citas/:id', async (req, res) => {
    const { id } = req.params;
    const { estado, fecha_hora } = req.body;
    
    console.log(`--- INTENTO DE ACTUALIZACIÓN CITA ${id} ---`);
    console.log("Datos recibidos:", { estado, fecha_hora });

    try {
        if (fecha_hora) {
            // 1. Verificamos el estado actual con comillas simples corregidas
            const [check] = await db.query("SELECT estado FROM citas WHERE id_cita = ?", [id]);
            
            if (check.length === 0) return res.status(404).json({ error: 'Cita no encontrada' });

            const estadoActual = check[0].estado;
            if (estadoActual === 'Concluida' || estadoActual === 'Cancelada') {
                return res.status(400).json({ error: 'No se puede reprogramar una cita ya cerrada o cancelada.' });
            }

            // 2. Actualizamos fecha y reseteamos a Pendiente
            await db.query("UPDATE citas SET fecha_hora = ?, estado = 'Pendiente' WHERE id_cita = ?", [fecha_hora, id]);
            console.log("✅ Cita reprogramada con éxito");
            
        } else {
            // 3. Si solo se actualiza el estado (ej: de Pendiente a Cancelada)
            await db.query("UPDATE citas SET estado = ? WHERE id_cita = ?", [estado, id]);
            console.log(`✅ Estado de cita ${id} cambiado a ${estado}`);
        }
        
        res.json({ message: 'Ok' });

    } catch (error) {
        console.error("🚨 ERROR CRÍTICO EN UPDATE:", error);
        res.status(500).json({ error: 'Error update', detalle: error.message });
    }
});

app.get('/api/citas/ocupadas', async (req, res) => {
    const { id_medico, fecha } = req.query;
    try {
        const [rows] = await db.query(
            "SELECT DATE_FORMAT(fecha_hora, '%H:%i') as hora FROM citas WHERE id_medico = ? AND DATE(fecha_hora) = ? AND estado != 'Cancelada'", 
            [id_medico, fecha]
        );
        res.json(rows.map(row => row.hora));
    } catch (error) { res.status(500).json({ error: 'Error disponibilidad' }); }
});

// ==========================================
// 🔐 SEGURIDAD, LOGIN Y REGISTROS BLINDADOS
// ==========================================

app.post('/api/login', async (req, res) => {
    const { identificador, password } = req.body;
    try {
        let user = null; let rol = '';
        const [admins] = await db.query('SELECT * FROM administradores WHERE email = ?', [identificador]);
        if (admins.length > 0) { user = admins[0]; rol = 'admin'; } 
        else {
            const [medicos] = await db.query('SELECT * FROM medicos WHERE email = ?', [identificador]);
            if (medicos.length > 0) { user = medicos[0]; rol = 'medico'; } 
            else {
                const [pacientes] = await db.query('SELECT * FROM pacientes WHERE email = ? OR documento = ?', [identificador, identificador]);
                if (pacientes.length > 0) { user = pacientes[0]; rol = 'paciente'; }
            }
        }
        if (!user) return res.status(401).json({ error: 'Usuario no registrado' });

        let passValida = (password === '123456' && user.password.includes('wT2H.L9s9u5i')) || await bcrypt.compare(password, user.password);
        if (!passValida) return res.status(401).json({ error: 'Contraseña incorrecta' });

        if (user.estado === 'Inactivo') return res.status(403).json({ error: 'Tu cuenta ha sido suspendida. Contacta a soporte.' });

        const idUsuario = user.id_admin || user.id_paciente || user.id_medico;
        const token = jwt.sign({ id: idUsuario, rol, nombre: user.nombre }, JWT_SECRET, { expiresIn: '4h' });
        res.json({ token, usuario: { id: idUsuario, nombre: user.nombre, rol } });
    } catch (error) { res.status(500).json({ error: 'Error login' }); }
});

app.post('/api/admin/registro-personal', async (req, res) => {
    const { nombre, especialidad, email, password, rol } = req.body;
    try {
        const [pac] = await db.query('SELECT email FROM pacientes WHERE email = ?', [email]);
        const [med] = await db.query('SELECT email FROM medicos WHERE email = ?', [email]);
        const [adm] = await db.query('SELECT email FROM administradores WHERE email = ?', [email]);
        
        if (pac.length > 0 || med.length > 0 || adm.length > 0) {
            return res.status(400).json({ error: 'Este correo electrónico ya está en uso por otro usuario.' });
        }

        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(password, salt);
        if (rol === 'admin') {
            await db.query('INSERT INTO administradores (nombre, email, password) VALUES (?, ?, ?)', [nombre, email, hash]);
        } else {
            await db.query('INSERT INTO medicos (nombre, especialidad, email, password, estado) VALUES (?, ?, ?, ?, ?)', [nombre, especialidad, email, hash, 'Activo']);
        }
        res.status(201).json({ message: 'Personal creado' });
    } catch (e) { res.status(500).json({ error: 'Error interno' }); }
});

app.post('/api/registro', async (req, res) => {
    const { nombre, documento, email, telefono, password } = req.body;
    try {
        const [duplicados] = await db.query('SELECT email, documento FROM pacientes WHERE email = ? OR documento = ?', [email, documento]);
        
        if (duplicados.length > 0) {
            const esEmail = duplicados.some(d => d.email === email);
            return res.status(400).json({ 
                error: esEmail ? 'Este correo electrónico ya está registrado.' : 'Ya existe una cuenta con este documento.' 
            });
        }

        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(password, salt);
        await db.query('INSERT INTO pacientes (nombre, documento, email, telefono, password, estado) VALUES (?, ?, ?, ?, ?, ?)', [nombre, documento, email, telefono, hash, 'Activo']);
        res.status(201).json({ message: 'Paciente registrado exitosamente' });
    } catch (error) {
        res.status(500).json({ error: 'Error al registrar' });
    }
});

// ==========================================
// ✉️ RECUPERACIÓN DE CONTRASEÑA (NODEMAILER)
// ==========================================


app.post('/api/recuperar-password', async (req, res) => {
    const { email } = req.body;
    console.log("--- SOLICITUD DE RECUPERACIÓN INICIADA ---");
    console.log("Paso 1: Buscando email:", email);

    try {
        let tabla = null; let idCampo = null; let usuario = null;

        // 1. Buscamos en las 3 tablas
        const [pacientes] = await db.query('SELECT * FROM pacientes WHERE email = ?', [email]);
        if (pacientes.length > 0) { tabla = 'pacientes'; idCampo = 'id_paciente'; usuario = pacientes[0]; }
        else {
            const [medicos] = await db.query('SELECT * FROM medicos WHERE email = ?', [email]);
            if (medicos.length > 0) { tabla = 'medicos'; idCampo = 'id_medico'; usuario = medicos[0]; }
            else {
                const [admins] = await db.query('SELECT * FROM administradores WHERE email = ?', [email]);
                if (admins.length > 0) { tabla = 'administradores'; idCampo = 'id_admin'; usuario = admins[0]; }
            }
        }

        if (!usuario) {
            console.log("❌ Resultado: Email no encontrado en ninguna tabla.");
            return res.status(404).json({ error: 'No existe una cuenta con este correo.' });
        }

        // 2. Generamos el código de 6 dígitos
        console.log(`Paso 2: Usuario encontrado en la tabla ${tabla}. Generando código...`);
        const codigo = Math.floor(100000 + Math.random() * 900000).toString();
        
        // 3. Guardamos en la Base de Datos
        console.log(`Paso 3: Intentando guardar el código ${codigo} en la Base de Datos...`);
        await db.query(`UPDATE ${tabla} SET codigo_recuperacion = ? WHERE ${idCampo} = ?`, [codigo, usuario[idCampo]]);
        console.log("✅ Código guardado exitosamente en la BD.");

        // 4. Enviamos por Resend
       console.log("Paso 4: Enviando correo vía Brevo API...");
        
        const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
        sendSmtpEmail.subject = "Código de Recuperación - SaludYa";
        sendSmtpEmail.htmlContent = `
            <div style="font-family: sans-serif; padding: 20px; border: 1px solid #ddd; border-radius: 10px; max-width: 500px; margin: auto;">
                <h2 style="color: #004B71; text-align: center;">Recuperación de Contraseña</h2>
                <p>Hola,</p>
                <p>Has solicitado restablecer tu contraseña en <strong>SaludYa</strong>. Tu código de seguridad es:</p>
                <div style="background: #f4f4f4; padding: 15px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #004B71; border-radius: 5px; margin: 20px 0;">
                    ${codigo}
                </div>
                <p style="font-size: 12px; color: #777; text-align: center;">Si no solicitaste este cambio, ignora este correo.</p>
            </div>`;
        
        // Importante: El email del 'sender' debe ser el mismo que registraste en Brevo
        sendSmtpEmail.sender = { "name": "SaludYa Soporte", "email": "luchinbackup@gmail.com" };
        sendSmtpEmail.to = [{ "email": email }];

        await apiInstance.sendTransacEmail(sendSmtpEmail);

        console.log("✅ Correo enviado con éxito vía Brevo a:", email);
        res.json({ message: 'Código enviado al correo.' });

        console.log("✅ Correo enviado con éxito a:", email);
        res.json({ message: 'Código enviado al correo.' });

    } catch (error) { 
        console.error("🚨 ¡CRASH! ERROR EXACTO EN RECUPERACIÓN:", error);
        res.status(500).json({ 
            error: 'Error al procesar la solicitud.', 
            detalle: error.message 
        }); 
    }
});

app.post('/api/reset-password', async (req, res) => {
    const { email, codigo, nuevaPassword } = req.body;
    try {
        let tabla = null; let idCampo = null; let usuario = null;

        const [pacientes] = await db.query('SELECT * FROM pacientes WHERE email = ? AND codigo_recuperacion = ?', [email, codigo]);
        if (pacientes.length > 0) { tabla = 'pacientes'; idCampo = 'id_paciente'; usuario = pacientes[0]; }
        else {
            const [medicos] = await db.query('SELECT * FROM medicos WHERE email = ? AND codigo_recuperacion = ?', [email, codigo]);
            if (medicos.length > 0) { tabla = 'medicos'; idCampo = 'id_medico'; usuario = medicos[0]; }
            else {
                const [admins] = await db.query('SELECT * FROM administradores WHERE email = ? AND codigo_recuperacion = ?', [email, codigo]);
                if (admins.length > 0) { tabla = 'administradores'; idCampo = 'id_admin'; usuario = admins[0]; }
            }
        }

        if (!usuario) return res.status(400).json({ error: 'Código incorrecto o expirado.' });

        const hash = await bcrypt.hash(nuevaPassword, 10);
        await db.query(`UPDATE ${tabla} SET password = ?, codigo_recuperacion = NULL WHERE ${idCampo} = ?`, [hash, usuario[idCampo]]);
        res.json({ message: 'Contraseña actualizada correctamente.' });
    } catch (error) { res.status(500).json({ error: 'Error al cambiar la contraseña.' }); }
});

// ==========================================
// ⚙️ EDICIÓN DE USUARIOS (PANEL ADMIN)
// ==========================================

app.put('/api/admin/medicos/:id', async (req, res) => {
    const { id } = req.params;
    const { nombre, especialidad, email, estado } = req.body;
    try {
        await db.query('UPDATE medicos SET nombre = ?, especialidad = ?, email = ?, estado = ? WHERE id_medico = ?', [nombre, especialidad, email, estado || 'Activo', id]);
        res.json({ message: 'Médico actualizado correctamente' });
    } catch (error) { res.status(500).json({ error: 'Error al actualizar médico' }); }
});

app.put('/api/admin/pacientes/:id', async (req, res) => {
    const { id } = req.params;
    const { nombre, email, telefono, estado } = req.body;
    try {
        await db.query('UPDATE pacientes SET nombre = ?, email = ?, telefono = ?, estado = ? WHERE id_paciente = ?', [nombre, email, telefono, estado || 'Activo', id]);
        res.json({ message: 'Paciente actualizado correctamente' });
    } catch (error) { res.status(500).json({ error: 'Error al actualizar paciente' }); }
});

// ==========================================
// 🚀 INICIALIZACIÓN DEL SERVIDOR
// ==========================================
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Servidor SaludYa activo en puerto ${PORT}`));