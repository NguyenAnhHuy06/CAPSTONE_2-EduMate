const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

// dotenv.config();
const path = require("path");
dotenv.config({ path: path.resolve(__dirname, "../.env") });

console.log("DB_USER:", process.env.DB_USER);

const { sequelize, ensureDatabase } = require('./config/db');
const teamDb = require('./config/teamDb');

// Routes
const authRoutes = require('./routes/authRoutes');
const documentRoutes = require('./routes/documentRoutes');
const quizRoutes = require('./routes/quizRoutes');
const chatRoutes = require('./routes/chatRoutes');
const flashcardRoutes = require('./routes/flashcardRoutes');
const adminRoutes = require('./routes/adminRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const progressRoutes = require('./routes/progressRoutes');
const donateRoutes = require('./routes/donateRoutes');
const donationRoutes = require('./routes/donationRoutes');

// Initialize Associations
require('./models/associations');

const app = express();

app.use(cors());
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));

// Health check
app.get('/', (req, res) => res.json({ success: true, message: 'EduMate API is running.' }));

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api', quizRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/flashcards', flashcardRoutes);
// Backward-compatible aliases for older frontend paths.
app.use('/api/ai/flashcard', flashcardRoutes);
app.use('/api/ai/flashcards', flashcardRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/progress', progressRoutes);
app.use('/api/donate', donateRoutes);
app.use('/api/donations', donationRoutes);

// 404 handler
app.use((req, res) => {
    res.status(404).json({ success: false, message: 'API endpoint not found.' });
});

// Error handler (multer, etc.)
app.use((err, req, res, next) => {
    const multer = require('multer');
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ success: false, message: 'File exceeds 10MB limit.' });
        }
        return res.status(400).json({ success: false, message: err.message || 'File upload error.' });
    }
    if (err) {
        return res.status(400).json({ success: false, message: err.message || 'Server error.' });
    }
    next();
});

const PORT = process.env.PORT || 5000;

const startServer = async () => {
    try {
        // 1. Ensure database exists
        await ensureDatabase();

        // 2. Sequelize sync (creates/migrates all model tables)
        await sequelize.sync();
        console.log('Database connected (Squelize).');
        console.log('Database connected and synced (Sequelize).');

        // 3. Seed roles table
        try {
            const Role = require('./models/Role');
            const roles = ['STUDENT', 'LECTURER', 'ADMIN'];
            for (const roleName of roles) {
                await Role.findOrCreate({ where: { role_name: roleName } });
            }
            console.log('Roles seeded: STUDENT, LECTURER, ADMIN');
        } catch (roleErr) {
            console.warn('Could not seed roles:', roleErr.message);
        }

        // 4. Init mysql2 pool for team queries (documents, quizzes, etc.)
        if (teamDb.isConfigured()) {
            await teamDb.initDb();
            console.log('teamDb (mysql2) ready — documents + quizzes tables checked.');
        } else {
            console.warn('teamDb: MySQL not fully configured.');
        }

        app.listen(PORT, () => {
            console.log(`Server running on http://localhost:${PORT}`);
        });
    } catch (err) {
        console.error('Unable to start server:', err);
        process.exit(1);
    }
};

process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
});

startServer();
