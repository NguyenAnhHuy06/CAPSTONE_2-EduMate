const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

// Design ref: Database Design — "flashcards" table
const Flashcard = sequelize.define('Flashcard', {
    flashcard_id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    user_id: {
        type: DataTypes.STRING(36), // Standardized for MySQL FK compatibility
        allowNull: false
    },
    document_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    front_text: {
        type: DataTypes.TEXT,
        allowNull: false
    },
    back_text: {
        type: DataTypes.TEXT,
        allowNull: false
    },
    created_at: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW
    }
}, {
    tableName: 'flashcards',
    timestamps: false
});

module.exports = Flashcard;
