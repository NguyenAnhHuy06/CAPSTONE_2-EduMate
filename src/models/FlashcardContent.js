const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const FlashcardContent = sequelize.define('FlashcardContent', {
    content_id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    flashcard_id: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    front_text: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    back_text: {
        type: DataTypes.TEXT,
        allowNull: true
    },
}, {
    tableName: 'flashcard_contents',
    timestamps: false
});

module.exports = FlashcardContent;
