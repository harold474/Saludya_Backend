const mysql = require('mysql2');
require('dotenv').config();

// Creamos la conexión usando los datos del archivo .env
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

// Usamos promesas para que el código sea más moderno y fácil de leer
const promisePool = pool.promise();

// Probamos que la conexión funcione
promisePool.getConnection()
    .then(connection => {
        console.log('¡Conexión a la base de datos MySQL de XAMPP exitosa!');
        connection.release(); // Soltamos la conexión para no saturar la base de datos
    })
    .catch(err => {
        console.error('Error conectando a la base de datos:', err);
    });

module.exports = promisePool;