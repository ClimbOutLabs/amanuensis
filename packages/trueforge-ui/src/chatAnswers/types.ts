/** One chat's latest answer, as the server stamped it on the chat when the answer landed. */
export type ChatAnswerMark = {
  sessionId: string;
  /** ISO time the chat's latest answer landed. */
  answeredAt: string;
};

/** Where a page gets the latest answer times of the person's chats. */
export type ChatAnswerMarksApi = {
  listAnswerMarks: () => Promise<readonly ChatAnswerMark[]>;
};
