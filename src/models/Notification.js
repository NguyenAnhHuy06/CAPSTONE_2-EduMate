const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

// Design ref: Database Design — "notifications" table
const Notification = sequelize.define('Notification', {
    notification_id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    user_id: {
        type: DataTypes.STRING(36), // Standardized for MySQL FK compatibility
        allowNull: false
    },
    type: {
        type: DataTypes.ENUM('info', 'success', 'warning', 'error'),
        defaultValue: 'info'
    },
    title: {
        type: DataTypes.STRING(255),
        allowNull: true
    },
    content: {
        type: DataTypes.TEXT,
        allowNull: false
    },
    is_read: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
    },
    created_at: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW
    }
}, {
    tableName: 'notifications',
    timestamps: false
});

module.exports = Notification;
