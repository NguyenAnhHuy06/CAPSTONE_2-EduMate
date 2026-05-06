const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Donation = sequelize.define(
  'Donation',
  {
    donation_id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    user_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    donor_name: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    donor_email: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    amount: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
    },
    currency: {
      type: DataTypes.STRING(10),
      allowNull: false,
      defaultValue: 'VND',
    },
    transfer_note: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    transaction_code: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    message: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    receipt_file_key: {
      type: DataTypes.STRING(1000),
      allowNull: false,
    },
    receipt_original_name: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    receipt_mime_type: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    receipt_size: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    status: {
      type: DataTypes.ENUM('PENDING', 'CONFIRMED', 'REJECTED'),
      allowNull: false,
      defaultValue: 'PENDING',
    },
    admin_note: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    confirmed_by: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    confirmed_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: 'donations',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['user_id'] },
      { fields: ['status'] },
      { fields: ['created_at'] },
    ],
  }
);

module.exports = Donation;