const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Document = sequelize.define('Document', {
    document_id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    title: {
        type: DataTypes.STRING(255),
        allowNull: false
    },
    file_url: {
        type: DataTypes.STRING(512),
        allowNull: true
    },
    course_id: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    uploader_id: {
        type: DataTypes.STRING(36), // Standardized for MySQL FK compatibility
        allowNull: true
    },
    version: {
        type: DataTypes.INTEGER,
        defaultValue: 1
    },
    status: {
        type: DataTypes.ENUM('pending', 'verified', 'rejected'),
        defaultValue: 'pending'
    }
}, {
    tableName: 'documents',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
});

module.exports = Document;
