const { Sequelize } = require('sequelize');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');

dotenv.config();

// Create the database if it doesn't exist
const ensureDatabase = async () => {
    try {
        const connection = await mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
        });
        const dbName = process.env.DB_NAME.replace(/[^a-zA-Z0-9_]/g, '');
        await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\`;`);
        await connection.end();
        console.log(`Database "${process.env.DB_NAME}" ensured.`);
    } catch (err) {
        console.error('Could not ensure database exists:', err.message);
    }
};

const sequelize = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD, {
    host: process.env.DB_HOST,
    dialect: 'mysql',
    logging: false
});

module.exports = { sequelize, ensureDatabase };

// Import all models to register them with Sequelize (so sync() creates tables)
require('../models/User');
require('../models/Role');
require('../models/Document');
require('../models/DocumentSegment');
require('../models/Quiz');
require('../models/QuizQuestion');
require('../models/QuizAttempt');
require('../models/Course');
require('../models/ChatSession');
require('../models/ChatMessage');
require('../models/Citation');
require('../models/Flashcard');
require('../models/ActivityLog');
require('../models/Notification');
