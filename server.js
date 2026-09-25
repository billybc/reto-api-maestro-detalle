/* ============================================================
   API Maestro-Detalle con Catálogo y Control de Estado
   Endpoints:
   - POST /api/registro    -> upsert estudiante + detalle de misiones
   - GET  /api/misiones    -> catálogo de misiones
   - GET  /api/estudiantes -> listado de estudiantes con sus misiones
   ============================================================ */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const sql = require("mssql");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/* --------------------------------------------------------------
   Configuración de la base de datos.
   Usa variables de entorno si existen; si no, cae en las
   credenciales que dio el catedrático (útil para desplegar rápido
   sin tener que configurar nada en el hosting).
   Si la conexión falla por certificado, probá cambiar
   encrypt/trustServerCertificate abajo.
   -------------------------------------------------------------- */
const dbConfig = {
  user: process.env.DB_USER || "UsuarioEncuestas",
  password: process.env.DB_PASSWORD || "DesaWeb2025$!",
  server: process.env.DB_SERVER || "svr-sql-ctezo.southcentralus.cloudapp.azure.com",
  database: process.env.DB_DATABASE || "db_WebDevUMG",
  port: parseInt(process.env.DB_PORT || "1433", 10),
  options: {
    encrypt: false,
    trustServerCertificate: true,
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
};

let poolPromise;
function getPool() {
  if (!poolPromise) {
    poolPromise = sql.connect(dbConfig).catch((err) => {
      poolPromise = null;
      throw err;
    });
  }
  return poolPromise;
}

/* ============================================================
   POST /api/registro
   ============================================================ */
app.post("/api/registro", async (req, res) => {
  try {
    const { maestro, detalle } = req.body || {};

    if (!maestro || !maestro.carnet || !maestro.nombre || !maestro.correo) {
      return res.status(400).json({
        error: 'El campo "maestro" debe incluir carnet, nombre y correo.',
      });
    }
    if (!Array.isArray(detalle)) {
      return res.status(400).json({
        error: 'El campo "detalle" debe ser un arreglo de misiones.',
      });
    }

    const pool = await getPool();

    // 1-2. Insertar o actualizar estudiante (upsert por Carnet)
    const reqBuscarEst = pool.request();
    reqBuscarEst.input("carnet", sql.VarChar(25), maestro.carnet);
    const existeEst = await reqBuscarEst.query(
      "SELECT Carnet FROM Estudiantes WHERE Carnet = @carnet"
    );

    if (existeEst.recordset.length === 0) {
      const reqIns = pool.request();
      reqIns.input("carnet", sql.VarChar(25), maestro.carnet);
      reqIns.input("nombre", sql.NVarChar(150), maestro.nombre);
      reqIns.input("correo", sql.NVarChar(150), maestro.correo);
      await reqIns.query(
        "INSERT INTO Estudiantes (Carnet, Nombre, Correo) VALUES (@carnet, @nombre, @correo)"
      );
    } else {
      const reqUpd = pool.request();
      reqUpd.input("carnet", sql.VarChar(25), maestro.carnet);
      reqUpd.input("nombre", sql.NVarChar(150), maestro.nombre);
      reqUpd.input("correo", sql.NVarChar(150), maestro.correo);
      await reqUpd.query(
        "UPDATE Estudiantes SET Nombre = @nombre, Correo = @correo WHERE Carnet = @carnet"
      );
    }

    // 3-4. Procesar el detalle (misiones)
    const errores = [];
    const procesados = [];

    for (const item of detalle) {
      const misionId = item.misionId;
      const estado = !!item.estado;

      const reqMision = pool.request();
      reqMision.input("misionId", sql.Int, misionId);
      const misionExiste = await reqMision.query(
        "SELECT MisionID FROM Misiones WHERE MisionID = @misionId"
      );

      if (misionExiste.recordset.length === 0) {
        errores.push({ misionId, error: "La misión no existe en el catálogo." });
        continue;
      }

      const reqCheck = pool.request();
      reqCheck.input("carnet", sql.VarChar(25), maestro.carnet);
      reqCheck.input("misionId", sql.Int, misionId);
      const existeDetalle = await reqCheck.query(
        "SELECT DetalleID FROM EstudianteMisiones WHERE Carnet = @carnet AND MisionID = @misionId"
      );

      if (existeDetalle.recordset.length === 0) {
        const reqInsD = pool.request();
        reqInsD.input("carnet", sql.VarChar(25), maestro.carnet);
        reqInsD.input("misionId", sql.Int, misionId);
        reqInsD.input("estado", sql.Bit, estado);
        await reqInsD.query(
          "INSERT INTO EstudianteMisiones (Carnet, MisionID, Estado, FechaRegistro) VALUES (@carnet, @misionId, @estado, GETDATE())"
        );
      } else {
        const reqUpdD = pool.request();
        reqUpdD.input("carnet", sql.VarChar(25), maestro.carnet);
        reqUpdD.input("misionId", sql.Int, misionId);
        reqUpdD.input("estado", sql.Bit, estado);
        await reqUpdD.query(
          "UPDATE EstudianteMisiones SET Estado = @estado, FechaRegistro = GETDATE() WHERE Carnet = @carnet AND MisionID = @misionId"
        );
      }

      procesados.push({ misionId, estado });
    }

    if (errores.length > 0) {
      return res.status(400).json({
        mensaje: "Estudiante registrado/actualizado, pero hay errores de referencia en algunas misiones.",
        carnet: maestro.carnet,
        procesados,
        errores,
      });
    }

    return res.status(200).json({
      mensaje: "Registro procesado correctamente.",
      carnet: maestro.carnet,
      procesados,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Error interno del servidor.", detalle: err.message });
  }
});

/* ============================================================
   GET /api/misiones
   ============================================================ */
app.get("/api/misiones", async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .query("SELECT MisionID, Nombre, Descripcion FROM Misiones ORDER BY MisionID");
    res.json(result.recordset);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error interno del servidor.", detalle: err.message });
  }
});

/* ============================================================
   GET /api/estudiantes
   ============================================================ */
app.get("/api/estudiantes", async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT e.Carnet, e.Nombre, e.Correo, m.MisionID, m.Nombre AS MisionNombre, em.Estado
      FROM Estudiantes e
      LEFT JOIN EstudianteMisiones em ON em.Carnet = e.Carnet
      LEFT JOIN Misiones m ON m.MisionID = em.MisionID
      ORDER BY e.Carnet, m.MisionID
    `);

    const mapa = new Map();
    for (const fila of result.recordset) {
      if (!mapa.has(fila.Carnet)) {
        mapa.set(fila.Carnet, {
          carnet: fila.Carnet,
          nombre: fila.Nombre,
          correo: fila.Correo,
          misiones: [],
        });
      }
      if (fila.MisionID !== null) {
        mapa.get(fila.Carnet).misiones.push({
          misionId: fila.MisionID,
          nombre: fila.MisionNombre,
          estado: !!fila.Estado,
        });
      }
    }

    res.json(Array.from(mapa.values()));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error interno del servidor.", detalle: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor escuchando en el puerto ${PORT}`));
