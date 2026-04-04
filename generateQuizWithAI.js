const { generateQuiz } = require("./quizService");

/**
 * Wrapper giữ tương thích tên hàm cũ.
 * @returns {Promise<{ questions: Array, targetCount: number }>}
 */
async function generateQuizWithAI(params) {
  return generateQuiz(params);
}

module.exports = { generateQuizWithAI, generateQuiz };
