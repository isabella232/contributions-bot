module.exports = isMessageByApp

/**
 * @param {import('probot').Context} context
 */
function isMessageByApp(context) {
    return context.payload.sender.login.endsWith('-bot')
}
