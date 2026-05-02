const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const QuizQuestion = sequelize.define('QuizQuestion', {
    question_id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    quiz_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    question_text: {
        type: DataTypes.TEXT,
        allowNull: false
    },
    option_a: { type: DataTypes.STRING(255), allowNull: true },
    option_b: { type: DataTypes.STRING(255), allowNull: true },
    option_c: { type: DataTypes.STRING(255), allowNull: true },
    option_d: { type: DataTypes.STRING(255), allowNull: true },
    correct_answer: {
        type: DataTypes.STRING(1),
        allowNull: false,
        defaultValue: 'A'
    },
    explanation: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'explanation',
    },
}, {
    tableName: 'quiz_questions',
    timestamps: false
});

module.exports = QuizQuestion;
