/**
 * Client router path to open a quiz right after create/generate.
 * Match these to your SPA routes so navigation lands on the quiz view in one step
 * (no intermediate "quiz list" tab). Use :id as the placeholder.
 */
function isStaffRole(role) {
  const r = String(role || "").trim().toUpperCase();
  return r === "LECTURER" || r === "TEACHER" || r === "ADMIN";
}

function quizNavigatePath(quizId, options = {}) {
  const id = String(quizId);
  const role = options.role;
  const staffTpl = process.env.QUIZ_LECTURER_NAVIGATE_PATH_TEMPLATE;
  if (staffTpl && isStaffRole(role)) {
    return String(staffTpl).replace(/:id/g, id);
  }
  const tpl = process.env.QUIZ_NAVIGATE_PATH_TEMPLATE || "/quiz/:id";
  return String(tpl).replace(/:id/g, id);
}

const QUIZ_NAVIGATE_REPLACE_DEFAULT = true;

module.exports = { quizNavigatePath, isStaffRole, QUIZ_NAVIGATE_REPLACE_DEFAULT };
