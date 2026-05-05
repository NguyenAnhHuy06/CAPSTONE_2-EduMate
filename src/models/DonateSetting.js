const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const DonateSetting = sequelize.define(
  'DonateSetting',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    account_name: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    bank_name: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    account_number: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    qr_image_url: {
      type: DataTypes.STRING(1000),
      allowNull: true,
    },
    transfer_note: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    message: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    is_enabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
  },
  {
    tableName: 'donate_settings',
    timestamps: true,
    createdAt: false,
    updatedAt: 'updated_at',
  }
);

module.exports = DonateSetting;