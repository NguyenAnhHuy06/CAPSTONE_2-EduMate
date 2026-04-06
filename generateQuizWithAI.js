const { generateQuiz } = require("./quizService");

/**
 * Wrapper keeping the legacy function name.
 * @returns {Promise<{ questions: Array, targetCount: number }>}
 */
async function generateQuizWithAI(params) {
  return generateQuiz(params);
}

module.exports = { generateQuizWithAI, generateQuiz };
