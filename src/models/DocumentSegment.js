const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const DocumentSegment = sequelize.define('DocumentSegment', {
    segment_id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    document_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    content: {
        type: DataTypes.TEXT('long'),
        allowNull: true
    },
    embedding: {
        type: DataTypes.TEXT('long'),
        allowNull: true
    }
}, {
    tableName: 'document_segments',
    timestamps: false
});

module.exports = DocumentSegment;
