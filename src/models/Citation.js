const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

// Design ref: Database Design — "citations" table
// Links AI responses to source document segments for verifiability
const Citation = sequelize.define('Citation', {
    citation_id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    message_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    segment_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    excerpt: {
        type: DataTypes.TEXT,
        allowNull: true
    }
}, {
    tableName: 'citations',
    timestamps: false
});

module.exports = Citation;
