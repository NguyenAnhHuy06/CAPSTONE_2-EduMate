const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Flashcard = sequelize.define('Flashcard', {
    flashcard_id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    user_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    document_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    /** Groups cards into one saved set (FE: flashcard_set_id). */
    flashcard_set_id: {
        type: DataTypes.STRING(128),
        allowNull: true,
    },
    created_at: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW
    },
}, {
    tableName: 'flashcards',
    timestamps: false
});

module.exports = Flashcard;