// Stands in for AnythingLLM's utils/PushNotifications in the tests (ANYTHINGLLM_SERVER_DIR points
// here): what was pushed, kept in globalThis.__libraryLeanPushes for the tests to read.
const sent = (globalThis.__libraryLeanPushes ||= []);

module.exports = {
  pushNotificationService: {
    loadSubscriptions: async () => {},
    sendNotification: async (notification) => void sent.push(notification),
  },
};
