let ioRef = null;

function initRealtimeHub(io) {
  ioRef = io;
}

function emitToUser(userId, event, payload) {
  const uid = Number(userId);
  if (!ioRef || !Number.isFinite(uid) || uid <= 0) return;
  ioRef.to(`user:${uid}`).emit(event, payload);
}

module.exports = {
  initRealtimeHub,
  emitToUser,
};
