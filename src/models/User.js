const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const User = sequelize.define('User', {
    user_id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    email: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true
    },
    password_hash: {
        field: 'password',
        type: DataTypes.STRING,
        allowNull: false
    },
    full_name: {
        field: 'name',
        type: DataTypes.STRING,
        allowNull: true
    },
    role: {
        type: DataTypes.ENUM('STUDENT', 'LECTURER', 'ADMIN'),
        defaultValue: 'STUDENT'
    },
    user_code: {
        type: DataTypes.STRING,
        allowNull: true
    },
    phone: {
        type: DataTypes.STRING(50),
        allowNull: true,
        unique: true
    },
    avatar_url: {
        type: DataTypes.STRING(500),
        allowNull: true
    },
    address: {
        type: DataTypes.STRING(255),
        allowNull: true
    },
    is_active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
    },
    is_verified: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
    },
    email_verified: {
        type: DataTypes.BOOLEAN,
        field: 'is_verified', // Map to same column if needed, or check DB
        defaultValue: false
    },
    external_uid: {
        type: DataTypes.STRING(255),
        allowNull: true
    },
    otp_code: {
        type: DataTypes.STRING,
        allowNull: true
    },
    otp_expires_at: {
        type: DataTypes.DATE,
        allowNull: true
    }
}, {
    tableName: 'users',
    timestamps: false
});

module.exports = User;