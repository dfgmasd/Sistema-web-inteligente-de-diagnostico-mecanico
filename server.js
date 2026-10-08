const express = require("express");
const sql = require("mssql");

const app = express();
app.use(express.json());
app.use(express.static("public"));

/* ===================== CONEXIÓN A SQL SERVER ===================== */
const config = {
    user: "usersql",
    password: "root123",
    server: "localhost",
    port: 53509,
    database: "TallerMecanicoDB",
    options: {
        encrypt: false,
        trustServerCertificate: true
    }
};

// Pool único y reutilizable; si falla la conexión se vuelve a intentar en la siguiente petición
let poolPromise = null;

function getPool() {
    if (!poolPromise) {

        console.log("========== CONFIGURACIÓN SQL ==========");
        console.log("Servidor:", config.server);
        console.log("Puerto:", config.port);
        console.log("Base de datos:", config.database);
        console.log("Usuario:", config.user);
        console.log("========================================");

        poolPromise = new sql.ConnectionPool(config)
            .connect()
            .then(pool => {
                console.log("=================================");
                console.log("CONEXIÓN EXITOSA A SQL SERVER");
                console.log("=================================");
                return pool;
            })
            .catch(err => {
                poolPromise = null;

                console.error("=================================");
                console.error("ERROR DE CONEXIÓN SQL SERVER");
                console.error(err);
                console.error("=================================");

                throw err;
            });
    }

    return poolPromise;
}

/* ===================== PREPARACIÓN DE LA BASE ===================== */
// Agrega las columnas que la web necesita y que el script original no traía
// (prioridad de la orden y datos del mantenimiento preventivo), y crea un usuario
// por defecto porque OrdenTrabajo.usuario_id es obligatorio.
let preparadoPromise = null;
function preparar() {
    if (!preparadoPromise) {
        preparadoPromise = (async () => {
            const pool = await getPool();
            const pasos = [
                `IF COL_LENGTH('OrdenTrabajo','prioridad') IS NULL
                    ALTER TABLE OrdenTrabajo ADD prioridad VARCHAR(20) NOT NULL
                    CONSTRAINT DF_Orden_Prioridad DEFAULT 'Normal'`,
                `IF COL_LENGTH('Mantenimiento','tipo') IS NULL
                    ALTER TABLE Mantenimiento ADD tipo VARCHAR(100) NULL`,
                `IF COL_LENGTH('Mantenimiento','km_proximo') IS NULL
                    ALTER TABLE Mantenimiento ADD km_proximo INT NULL`,
                `IF COL_LENGTH('Mantenimiento','fecha_programada') IS NULL
                    ALTER TABLE Mantenimiento ADD fecha_programada DATE NULL`,
                `IF COL_LENGTH('Mantenimiento','estado') IS NULL
                    ALTER TABLE Mantenimiento ADD estado VARCHAR(30) NOT NULL
                    CONSTRAINT DF_Mant_Estado DEFAULT 'Programado'`,
                `IF NOT EXISTS (SELECT 1 FROM Usuario)
                    INSERT INTO Usuario (nombres, correo, contrasena, rol, estado)
                    VALUES ('Mecanico', 'mecanico@jdtaller.com', 'sin-login', 'mecanico', 'activo')`
            ];
            for (const paso of pasos) {
                await pool.request().query(paso);
            }
            console.log("Base de datos lista (" + config.database + ")");
        })().catch(err => {
            preparadoPromise = null;
            throw err;
        });
    }
    return preparadoPromise;
}

// Todas las rutas /api esperan a que la base esté preparada
app.use("/api", async (req, res, next) => {
    try {
        await preparar();
        next();
    } catch (error) {
        console.error("Error de conexión/preparación:", error.message);
        res.status(500).json({
            error: "No se pudo conectar con la base de datos: " + error.message
        });
    }
});

/* ===================== UTILIDADES ===================== */
const ESTADOS_ORDEN = ["Pendiente", "En proceso", "Completada"];
const PRIORIDADES = ["Normal", "Alta", "Urgente"];
const ESTADOS_MANT = ["Programado", "Realizado"];

function httpError(status, message) {
    const e = new Error(message);
    e.status = status;
    return e;
}

function wrap(fn) {
    return (req, res) => {
        Promise.resolve(fn(req, res)).catch(error => {
            // Los errores de validación (4xx) no necesitan stack en consola
            if (!error.status || error.status >= 500) console.error(error);
            res.status(error.status || 500).json({ error: error.message });
        });
    };
}

function normEstado(s) {
    if (!s) return "";
    const t = String(s).trim();
    return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

function textoOpcional(v, max) {
    if (v == null) return null;
    const t = String(v).trim();
    if (!t) return null;
    return t.slice(0, max);
}

function enteroOpcional(v) {
    if (v === "" || v == null) return null;
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < 0 || n > 2147483647) return null;
    return n;
}

function validarPlaca(placa) {
    const p = String(placa || "").trim().toUpperCase();
    if (!p) throw httpError(400, "La placa/VIN es obligatoria.");
    if (p.length > 10) throw httpError(400, "La placa/VIN admite como máximo 10 caracteres.");
    return p;
}

// "Juan Carlos Mendoza García" -> nombres "Juan Carlos", apellidos "Mendoza García"
function partirNombre(cliente) {
    const partes = String(cliente || "").trim().split(/\s+/).filter(Boolean);
    if (partes.length === 0) return { nombres: "Sin registrar", apellidos: "-" };
    if (partes.length === 1) return { nombres: partes[0].slice(0, 100), apellidos: "-" };
    if (partes.length === 2) return { nombres: partes[0].slice(0, 100), apellidos: partes[1].slice(0, 100) };
    return {
        nombres: partes.slice(0, partes.length - 2).join(" ").slice(0, 100),
        apellidos: partes.slice(-2).join(" ").slice(0, 100)
    };
}

function nombreCompleto(nombres, apellidos) {
    if (!nombres || nombres === "Sin registrar") return "";
    return (nombres + (apellidos && apellidos !== "-" ? " " + apellidos : "")).trim();
}

// Busca el vehículo por placa; si no existe lo crea (junto con su propietario)
async function obtenerOCrearVehiculo(tx, datos) {
    const rq = () => new sql.Request(tx);
    const km = enteroOpcional(datos.kilometraje);

    const found = await rq()
        .input("placa", sql.VarChar(10), datos.placa)
        .query("SELECT vehiculo_id FROM Vehiculo WHERE placa = @placa");

    if (found.recordset.length) {
        const id = found.recordset[0].vehiculo_id;
        if (km !== null) {
            await rq()
                .input("id", sql.Int, id)
                .input("km", sql.Int, km)
                .query(`UPDATE Vehiculo SET kilometraje = @km
                        WHERE vehiculo_id = @id AND (kilometraje IS NULL OR kilometraje < @km)`);
        }
        return id;
    }

    // Propietario: reutiliza uno con el mismo nombre o crea uno nuevo
    const { nombres, apellidos } = partirNombre(datos.cliente);
    let propietarioId;
    const existente = await rq()
        .input("n", sql.VarChar(100), nombres)
        .input("a", sql.VarChar(100), apellidos)
        .query(`SELECT TOP 1 propietario_id FROM Propietario
                WHERE nombres = @n AND apellidos = @a AND documento LIKE 'SD-%'
                ORDER BY propietario_id`);
    if (existente.recordset.length && nombres !== "Sin registrar") {
        propietarioId = existente.recordset[0].propietario_id;
    } else {
        // documento es obligatorio y único: se genera uno provisional
        const documento = "SD-" + Date.now() + Math.floor(Math.random() * 90 + 10);
        const p = await rq()
            .input("n", sql.VarChar(100), nombres)
            .input("a", sql.VarChar(100), apellidos)
            .input("d", sql.VarChar(20), documento)
            .query(`INSERT INTO Propietario (nombres, apellidos, documento)
                    OUTPUT INSERTED.propietario_id
                    VALUES (@n, @a, @d)`);
        propietarioId = p.recordset[0].propietario_id;
    }

    // "Toyota Corolla" -> marca "Toyota", modelo "Corolla"
    const [marca, ...resto] = String(datos.marcaModelo || "").trim().split(/\s+/).filter(Boolean);
    const v = await rq()
        .input("pid", sql.Int, propietarioId)
        .input("placa", sql.VarChar(10), datos.placa)
        .input("marca", sql.VarChar(50), marca ? marca.slice(0, 50) : null)
        .input("modelo", sql.VarChar(50), resto.length ? resto.join(" ").slice(0, 50) : null)
        .input("km", sql.Int, km)
        .query(`INSERT INTO Vehiculo (propietario_id, placa, marca, modelo, kilometraje)
                OUTPUT INSERTED.vehiculo_id
                VALUES (@pid, @placa, @marca, @modelo, @km)`);
    return v.recordset[0].vehiculo_id;
}

async function usuarioPorDefecto(tx) {
    const r = await new sql.Request(tx).query("SELECT TOP 1 usuario_id FROM Usuario ORDER BY usuario_id");
    if (!r.recordset.length) throw httpError(500, "No hay ningún usuario registrado en la tabla Usuario.");
    return r.recordset[0].usuario_id;
}

async function enTransaccion(fn) {
    const pool = await getPool();
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
        const resultado = await fn(tx);
        await tx.commit();
        return resultado;
    } catch (error) {
        try { await tx.rollback(); } catch (e) { /* ya revertida */ }
        throw error;
    }
}

function idParam(req) {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) throw httpError(400, "Identificador inválido.");
    return id;
}

/* ===================== VEHÍCULOS ===================== */
app.get("/api/vehiculos", wrap(async (req, res) => {
    const pool = await getPool();
    const result = await pool.request().query("SELECT * FROM Vehiculo");
    res.json(result.recordset);
}));

/* ===================== ÓRDENES DE TRABAJO ===================== */
app.get("/api/ordenes", wrap(async (req, res) => {
    const pool = await getPool();
    const r = await pool.request().query(`
        SELECT o.orden_id AS id, v.placa, v.marca, v.modelo, v.kilometraje,
               p.nombres, p.apellidos, o.estado, o.prioridad,
               CONVERT(varchar(10), o.fecha, 23) AS fecha,
               (SELECT TOP 1 s.descripcion FROM Sintoma s
                 WHERE s.orden_id = o.orden_id ORDER BY s.sintoma_id) AS sintoma
        FROM OrdenTrabajo o
        JOIN Vehiculo v    ON v.vehiculo_id = o.vehiculo_id
        JOIN Propietario p ON p.propietario_id = v.propietario_id
        ORDER BY o.fecha DESC, o.orden_id DESC`);

    res.json(r.recordset.map(o => ({
        id: o.id,
        placa: o.placa,
        cliente: nombreCompleto(o.nombres, o.apellidos),
        marcaModelo: [o.marca, o.modelo].filter(Boolean).join(" "),
        kilometraje: o.kilometraje,
        prioridad: normEstado(o.prioridad) || "Normal",
        estado: normEstado(o.estado) || "Pendiente",
        sintoma: o.sintoma || "",
        fecha: o.fecha
    })));
}));

app.post("/api/ordenes", wrap(async (req, res) => {
    const b = req.body || {};
    const placa = validarPlaca(b.placa);
    const sintoma = textoOpcional(b.sintoma, 255);
    if (!sintoma) throw httpError(400, "El síntoma / motivo de ingreso es obligatorio.");
    const estado = ESTADOS_ORDEN.includes(b.estado) ? b.estado : "Pendiente";
    const prioridad = PRIORIDADES.includes(b.prioridad) ? b.prioridad : "Normal";

    const id = await enTransaccion(async tx => {
        const vehiculoId = await obtenerOCrearVehiculo(tx, {
            placa,
            cliente: b.cliente,
            marcaModelo: b.marcaModelo,
            kilometraje: b.kilometraje
        });
        const usuarioId = await usuarioPorDefecto(tx);

        const o = await new sql.Request(tx)
            .input("vid", sql.Int, vehiculoId)
            .input("uid", sql.Int, usuarioId)
            .input("estado", sql.VarChar(30), estado)
            .input("prioridad", sql.VarChar(20), prioridad)
            .query(`INSERT INTO OrdenTrabajo (vehiculo_id, usuario_id, estado, prioridad)
                    OUTPUT INSERTED.orden_id
                    VALUES (@vid, @uid, @estado, @prioridad)`);
        const ordenId = o.recordset[0].orden_id;

        await new sql.Request(tx)
            .input("oid", sql.Int, ordenId)
            .input("d", sql.VarChar(255), sintoma)
            .query("INSERT INTO Sintoma (orden_id, descripcion) VALUES (@oid, @d)");
        return ordenId;
    });

    res.status(201).json({ ok: true, id });
}));

app.put("/api/ordenes/:id/estado", wrap(async (req, res) => {
    const id = idParam(req);
    const estado = req.body && req.body.estado;
    if (!ESTADOS_ORDEN.includes(estado)) throw httpError(400, "Estado no válido.");
    const pool = await getPool();
    const r = await pool.request()
        .input("id", sql.Int, id)
        .input("estado", sql.VarChar(30), estado)
        .query("UPDATE OrdenTrabajo SET estado = @estado WHERE orden_id = @id");
    if (!r.rowsAffected[0]) throw httpError(404, "La orden no existe.");
    res.json({ ok: true });
}));

app.delete("/api/ordenes/:id", wrap(async (req, res) => {
    const id = idParam(req);
    await enTransaccion(async tx => {
        await new sql.Request(tx).input("id", sql.Int, id).query(`
            DELETE FROM Repuesto WHERE reparacion_id IN
                (SELECT reparacion_id FROM Reparacion WHERE orden_id = @id);
            DELETE FROM Reparacion  WHERE orden_id = @id;
            DELETE FROM Diagnostico WHERE orden_id = @id;
            DELETE FROM Sintoma     WHERE orden_id = @id;
            DELETE FROM OrdenTrabajo WHERE orden_id = @id;`);
    });
    res.json({ ok: true });
}));

/* ===================== MANTENIMIENTO PREVENTIVO ===================== */
app.get("/api/mantenimientos", wrap(async (req, res) => {
    const pool = await getPool();
    const r = await pool.request().query(`
        SELECT m.mantenimiento_id AS id, v.placa,
               ISNULL(m.tipo, ISNULL(m.descripcion, 'Mantenimiento')) AS tipo,
               m.kilometraje AS kmActual, m.km_proximo AS kmProximo,
               CONVERT(varchar(10), m.fecha_programada, 23) AS fechaProgramada,
               m.estado, m.descripcion AS notas,
               CONVERT(varchar(10), m.fecha, 23) AS fecha
        FROM Mantenimiento m
        JOIN Vehiculo v ON v.vehiculo_id = m.vehiculo_id
        ORDER BY m.fecha DESC, m.mantenimiento_id DESC`);

    res.json(r.recordset.map(m => ({
        id: m.id,
        placa: m.placa,
        tipo: m.tipo,
        kmActual: m.kmActual,
        kmProximo: m.kmProximo,
        fechaProgramada: m.fechaProgramada || "",
        estado: normEstado(m.estado) || "Programado",
        notas: m.notas && m.notas !== m.tipo ? m.notas : "",
        fecha: m.fecha
    })));
}));

app.post("/api/mantenimientos", wrap(async (req, res) => {
    const b = req.body || {};
    const placa = validarPlaca(b.placa);
    const tipo = textoOpcional(b.tipo, 100);
    if (!tipo) throw httpError(400, "El tipo de mantenimiento es obligatorio.");
    const estado = ESTADOS_MANT.includes(b.estado) ? b.estado : "Programado";
    const fechaProgramada = /^\d{4}-\d{2}-\d{2}$/.test(b.fechaProgramada || "") ? b.fechaProgramada : null;
    const kmActual = enteroOpcional(b.kmActual);
    const kmProximo = enteroOpcional(b.kmProximo);
    const notas = textoOpcional(b.notas, 255);

    const id = await enTransaccion(async tx => {
        const vehiculoId = await obtenerOCrearVehiculo(tx, { placa, kilometraje: kmActual });
        const m = await new sql.Request(tx)
            .input("vid", sql.Int, vehiculoId)
            .input("km", sql.Int, kmActual)
            .input("desc", sql.VarChar(255), notas)
            .input("tipo", sql.VarChar(100), tipo)
            .input("kmp", sql.Int, kmProximo)
            .input("fp", sql.VarChar(10), fechaProgramada)
            .input("estado", sql.VarChar(30), estado)
            .query(`INSERT INTO Mantenimiento
                        (vehiculo_id, kilometraje, descripcion, tipo, km_proximo, fecha_programada, estado)
                    OUTPUT INSERTED.mantenimiento_id
                    VALUES (@vid, @km, @desc, @tipo, @kmp, TRY_CONVERT(date, @fp, 23), @estado)`);
        return m.recordset[0].mantenimiento_id;
    });

    res.status(201).json({ ok: true, id });
}));

app.put("/api/mantenimientos/:id/estado", wrap(async (req, res) => {
    const id = idParam(req);
    const estado = req.body && req.body.estado;
    if (!ESTADOS_MANT.includes(estado)) throw httpError(400, "Estado no válido.");
    const pool = await getPool();
    const r = await pool.request()
        .input("id", sql.Int, id)
        .input("estado", sql.VarChar(30), estado)
        .query("UPDATE Mantenimiento SET estado = @estado WHERE mantenimiento_id = @id");
    if (!r.rowsAffected[0]) throw httpError(404, "El mantenimiento no existe.");
    res.json({ ok: true });
}));

app.delete("/api/mantenimientos/:id", wrap(async (req, res) => {
    const id = idParam(req);
    const pool = await getPool();
    await pool.request()
        .input("id", sql.Int, id)
        .query("DELETE FROM Mantenimiento WHERE mantenimiento_id = @id");
    res.json({ ok: true });
}));

/* ===================== HISTORIAL DEL VEHÍCULO ===================== */
// GET /api/historial?placa=ABC-123  (sin placa devuelve el vehículo con actividad más reciente)
app.get("/api/historial", wrap(async (req, res) => {
    const pool = await getPool();
    const placa = String(req.query.placa || "").trim().toUpperCase().replace(/[%_\[\]]/g, "");

    let q;
    if (placa) {
        q = await pool.request()
            .input("placa", sql.VarChar(10), placa.slice(0, 10))
            .query(`SELECT TOP 1 v.vehiculo_id, v.placa, v.marca, v.modelo, v.anio, v.kilometraje,
                           p.nombres, p.apellidos
                    FROM Vehiculo v JOIN Propietario p ON p.propietario_id = v.propietario_id
                    WHERE v.placa LIKE '%' + @placa + '%'
                    ORDER BY CASE WHEN v.placa = @placa THEN 0 ELSE 1 END, v.vehiculo_id`);
        if (!q.recordset.length) throw httpError(404, "No se encontró ningún vehículo con la placa \"" + placa + "\".");
    } else {
        q = await pool.request().query(`
            SELECT TOP 1 v.vehiculo_id, v.placa, v.marca, v.modelo, v.anio, v.kilometraje,
                   p.nombres, p.apellidos
            FROM Vehiculo v JOIN Propietario p ON p.propietario_id = v.propietario_id
            ORDER BY ISNULL((SELECT MAX(o.fecha) FROM OrdenTrabajo o WHERE o.vehiculo_id = v.vehiculo_id),
                            '19000101') DESC, v.vehiculo_id DESC`);
        if (!q.recordset.length) throw httpError(404, "Todavía no hay vehículos registrados.");
    }

    const v = q.recordset[0];
    const vid = v.vehiculo_id;
    const dePlaca = "SELECT orden_id FROM OrdenTrabajo WHERE vehiculo_id = @vid";

    const [ordenes, sintomas, diagnosticos, reparaciones, repuestos] = await Promise.all([
        pool.request().input("vid", sql.Int, vid).query(
            `SELECT orden_id, CONVERT(varchar(10), fecha, 23) AS fecha, estado, prioridad
             FROM OrdenTrabajo WHERE vehiculo_id = @vid ORDER BY fecha DESC, orden_id DESC`),
        pool.request().input("vid", sql.Int, vid).query(
            `SELECT orden_id, descripcion FROM Sintoma WHERE orden_id IN (${dePlaca}) ORDER BY sintoma_id`),
        pool.request().input("vid", sql.Int, vid).query(
            `SELECT orden_id, descripcion, resultado FROM Diagnostico
             WHERE orden_id IN (${dePlaca}) ORDER BY diagnostico_id`),
        pool.request().input("vid", sql.Int, vid).query(
            `SELECT reparacion_id, orden_id, descripcion, observaciones FROM Reparacion
             WHERE orden_id IN (${dePlaca}) ORDER BY reparacion_id`),
        pool.request().input("vid", sql.Int, vid).query(
            `SELECT rp.reparacion_id, rp.nombre, rp.cantidad, rp.estado
             FROM Repuesto rp JOIN Reparacion r ON r.reparacion_id = rp.reparacion_id
             WHERE r.orden_id IN (${dePlaca}) ORDER BY rp.repuesto_id`)
    ]);

    const repuestosPorReparacion = {};
    repuestos.recordset.forEach(r => {
        (repuestosPorReparacion[r.reparacion_id] = repuestosPorReparacion[r.reparacion_id] || []).push({
            nombre: r.nombre, cantidad: r.cantidad, estado: r.estado
        });
    });

    const agrupar = (filas, mapa) => {
        const out = {};
        filas.forEach(f => { (out[f.orden_id] = out[f.orden_id] || []).push(mapa(f)); });
        return out;
    };
    const sintomasPor = agrupar(sintomas.recordset, f => f.descripcion);
    const diagPor = agrupar(diagnosticos.recordset, f => ({ descripcion: f.descripcion, resultado: f.resultado }));
    const repPor = agrupar(reparaciones.recordset, f => ({
        descripcion: f.descripcion,
        observaciones: f.observaciones,
        repuestos: repuestosPorReparacion[f.reparacion_id] || []
    }));

    res.json({
        vehiculo: {
            placa: v.placa,
            marcaModelo: [v.marca, v.modelo].filter(Boolean).join(" "),
            anio: v.anio,
            kilometraje: v.kilometraje,
            propietario: nombreCompleto(v.nombres, v.apellidos)
        },
        ordenes: ordenes.recordset.map(o => ({
            id: o.orden_id,
            fecha: o.fecha,
            estado: normEstado(o.estado) || "Pendiente",
            prioridad: normEstado(o.prioridad) || "Normal",
            sintomas: sintomasPor[o.orden_id] || [],
            diagnosticos: diagPor[o.orden_id] || [],
            reparaciones: repPor[o.orden_id] || []
        }))
    });
}));

/* ===================== ARRANQUE ===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("Servidor: http://localhost:" + PORT);
    // Intenta conectar desde el arranque para avisar enseguida si algo falla
    preparar().catch(err => {
        console.error("\nNo se pudo conectar con SQL Server:", err.message);
        console.error("Revisa usuario/contraseña, que el servicio SQL Server (y SQL Server Browser) estén iniciados y que TCP/IP esté habilitado.\n");
    });
});
