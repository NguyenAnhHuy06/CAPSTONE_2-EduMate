const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Quiz = sequelize.define('Quiz', {
    quiz_id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    title: {
        type: DataTypes.STRING(255),
        allowNull: false
    },
    course_id: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    created_by: {
        type: DataTypes.STRING(36), // Standardized for MySQL FK compatibility
        allowNull: true
    },
    is_published: {
        type: DataTypes.TINYINT,
        defaultValue: 0
    },
    published_at: {
        type: DataTypes.DATE,
        allowNull: true
    },
    source_file_url: {
        type: DataTypes.STRING(512),
        allowNull: true
    },
    document_id: {
        type: DataTypes.INTEGER,
        allowNull: true
    }
}, {
    tableName: 'quizzes',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
});

module.exports = Quiz;
