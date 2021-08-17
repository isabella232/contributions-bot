const mailgun = require('mailgun-js')

const formatMessage = (contributorLevel, giftCardCode) => `
Thank you for contributing to PostHog!\n
You have leveled up to level ${contributorLevel} with your latest contribution.\n
Here's a merch code from us as a thank you: ${giftCardCode}\n
You can use this code on merch.posthog.com.\n\n
Best,\n
PostHog Team
`

class Mailer {
    constructor() {
        this.mg = mailgun({
            apiKey: process.env.MAILGUN_API_KEY,
            domain: process.env.MAILGUN_DOMAIN,
            host: process.env.MAILGUN_HOST,
        })
    }

    async sendGiftCardToContributor(contributorEmail, giftCardCode, contributorLevel) {
        const data = {
            from: 'PostHog Team <hey@posthog.com>',
            to: contributorEmail,
            subject: 'Thank you for your contribution to PostHog',
            text: formatMessage(contributorLevel, giftCardCode),
        }
        const mailgunResponse = await this.mg.messages().send(data)
        return mailgunResponse && mailgunResponse.message && mailgunResponse.message.toLowerCase().includes('queued')
    }

    async sendAlertEmail(message) {
        const data = {
            from: 'PostHog Team <hey@posthog.com>',
            to: 'phil@posthog.com',
            subject: 'Alert from Contributions Bot',
            text: message,
        }
        this.mg.messages().send(data, function (error) {
            if (error) {
                console.log('Unable to send alert email!')
            }
        })
    }
}

module.exports = {
    Mailer,
}
