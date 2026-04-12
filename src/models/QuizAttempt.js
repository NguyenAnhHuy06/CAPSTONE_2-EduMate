const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const QuizAttempt = sequelize.define('QuizAttempt', {
    attempt_id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    quiz_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    user_id: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    score: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    completed_at: {
        type: DataTypes.DATE,
        allowNull: true
    }
}, {
    tableName: 'quiz_attempts',
    timestamps: false
});

module.exports = QuizAttempt;
