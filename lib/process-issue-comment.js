const PostHog = require('posthog-node')
const { Mailer } = require('./mailer')
const { getEmailFromGithubUsername } = require('./utils')

const posthog = new PostHog(process.env.PH_PROJECT_API_KEY)
const mailer = new Mailer()

const parseComment = require('./parse-comment')
const toSafeGitReferenceName = require('./to-safe-git-reference-name')
const setupRepository = require('./setup-repository')
const getConfig = require('./get-config')
const addContributor = require('./add-contributor')
const { parseReminder } = require('./parse-reminder')
const schedule = require('node-schedule')
const CommentReply = require('./modules/comment-reply')
const moment = require('moment')

const reminderIdToJob = {}

async function processIssueComment({ context, commentReply, db }) {
    const commentBody = context.payload.comment.body


    const firstWord = commentBody.split(' ')[1]

    if (firstWord.slice(1) === "remind") {
        await processRemind({ context, commentReply, db })
    } else {
        await processContributionComment({ context, commentReply, db })
    }

}

async function processContributionComment ({ context, commentReply, db }) {
    const repo = context.payload.repository
    const createdBy = context.payload.comment.user

    const { who, action, contributions } = parseComment(commentBody)

    const log = context.log.child({
        who,
        action,
        contributions,
        account: repo.owner.id,
        accountType: repo.owner.type.toLowerCase(),
        accountLogin: repo.owner.login,
        createdBy: createdBy.id,
        createdByLogin: createdBy.login,
        createdByType: createdBy.type.toLowerCase(),
        repository: repo.id,
        private: repo.private,
        success: false,
    })

    if (action !== 'add') {
        log.info(`Unknown action "${action}"`)
        commentReply.reply(`I could not determine your intention.`)
        commentReply.reply(`Basic usage: @all-contributors please add @someone for code, doc and infra`)
        commentReply.reply(`For other usages see the [documentation](https://allcontributors.org/docs/en/bot/usage)`)
        return
    }

    if (contributions.length === 0) {
        log.info('No contributions')
        commentReply.reply(
            `I couldn't determine any contributions to add, did you specify any contributions?
          Please make sure to use [valid contribution names](https://allcontributors.org/docs/en/emoji-key).`
        )
        return
    }

    await processContribution({
        who,
        contributions,
        log,
        context: context,
        commentReply: commentReply,
        db: db,
    })
}

async function processContribution({
    who,
    contributions,
    log,
    context,
    commentReply = '',
    db,
    pullRequestUrl,
    extraMerch = false,
}) {
    const branchName = `all-contributors/add-${toSafeGitReferenceName(who)}`

    // set up repository instance. Uses branch if it exists, falls back to repository's default branch
    const repository = await setupRepository({ context, branchName })

    // loads configuration from repository. Initializes config if file does not exist
    const config = await getConfig(repository)

    repository.setSkipCi(config.options.skipCi)

    const isCodeContribution = contributions.includes('code')

    const {
        contributorUpdateQueryRes,
        contributorEmail,
        sendMerchSucceeded,
        errorMessage,
    } = await sendContributorMerch(who, isCodeContribution, db, extraMerch)

    if (isCodeContribution && !sendMerchSucceeded) {
        await mailer.sendAlertEmail(`Unable to provide a gift card code for ${who}.\nError message: ${errorMessage}`)
    }

    const { pullCreated, user } = await addContributor({
        context,
        commentReply,
        repository,
        config,
        who,
        contributions,
        branchName,
        pullRequestUrl,
        contributorEmail,
        isCodeContribution,
    })

    const userProps =
        contributorUpdateQueryRes && contributorUpdateQueryRes.querySucceeded
            ? { contributor_level: contributorUpdateQueryRes.contributorLevel }
            : {}

    posthog.capture({
        distinctId: `gh_user_${who}`,
        event: 'new_contribution',
        properties: {
            $set: userProps,
            $set_once: {
                email: contributorEmail,
            },
            is_code_contribution: isCodeContribution,
            contributions: contributions.join(','),
            gh_username: who,
        },
    })

    if (!pullCreated) {
        log.info(
            {
                pullCreated,
                success: true,
            },
            `${who} already have ${contributions.join(', ')}`
        )
        return
    }

    log.info(
        {
            pullCreated,
            success: true,
            createdFor: user.id,
            createdForType: 'user',
            createdForLogin: user.login.toLowerCase(),
        },
        `${who} added for ${contributions.join(', ')}`
    )
}

async function sendContributorMerch(who, isCodeContribution, db, extraMerch) {
    const defaultResponse = {
        contributorUpdateQueryRes: null,
        contributorEmail: '',
        sendMerchSucceeded: false,
        errorMessage: '',
    }

    // Only send merch automatically to those who contribute code
    if (!isCodeContribution) {
        return defaultResponse
    }

    contributorUpdateQueryRes = await db.handleNewContribution(who)
    defaultResponse.contributorUpdateQueryRes = contributorUpdateQueryRes

    // Handle Postgres query failures
    if (!contributorUpdateQueryRes.querySucceeded) {
        let res = { ...defaultResponse }
        res.errorMessage = 'Could not complete contributor update query.'
        return res
    }

    const giftCardLevel = extraMerch ? 2 : 1

    const giftCardCode = await db.getGiftCardCode(who, giftCardLevel, mailer)

    // No gift card available or query failed
    if (!giftCardCode) {
        let res = { ...defaultResponse }
        res.errorMessage = 'Could not get a gift card code from the database.'
        return res
    }

    contributorEmail = await getEmailFromGithubUsername(who)

    // Unable to get an email from GitHub using the public events method
    if (!contributorEmail) {
        let res = { ...defaultResponse }
        res.errorMessage = 'Could not find an email for the contributor.'
        return res
    }

    defaultResponse.contributorEmail = contributorEmail

    console.log(`Sending email to ${who} on ${contributorEmail} with gift card code ${giftCardCode}`)

    const emailSucceeded = await mailer.sendGiftCardToContributor(
        contributorEmail,
        giftCardCode,
        contributorUpdateQueryRes.contributorLevel
    )

    // Failed to send email via Mailgun
    if (!emailSucceeded) {
        let res = { ...defaultResponse }
        res.errorMessage = `Unable to send email to username ${who} with email ${contributorEmail}`
        return res
    }

    mailer.sendAlertEmail(`Sent gift card with code ${giftCardCode.trim()} to ${who} on email ${contributorEmail}`)

    // Using PostHog for logging :D
    posthog.capture({
        distinctId: `contributions-bot`,
        event: 'sent_gift_card',
        properties: {
            contributor_level: contributorUpdateQueryRes.contributorLevel,
            gift_card_code: giftCardCode,
            gh_username: who,
            contributor_email: contributorEmail,
        },
    })

    let res = { ...defaultResponse }
    res.sendMerchSucceeded = true

    return res
}

async function processRemind({ context, commentReply, db }) {
    const commentBody = context.payload.comment.body
    const remindCommand = commentBody.split(' ')[2].trim()
    console.log(remindCommand)
    const requestingUser = context.payload.comment.user.login

    switch (remindCommand.toLowerCase()) {
        case 'list':
            await listReminders({ context, commentReply, db, requestingUser, commentBody })
            break
        case 'delete':
            await deleteReminder({ context, commentReply, db, requestingUser, commentBody })
            break
        case 'define':
            await defineReminderGroup({ context, commentReply, db, requestingUser, commentBody })
            break
        case 'help':
            await remindHelp({ context, commentReply, db, requestingUser, commentBody })
            break
        default:
            await scheduleReminder({ context, commentReply, db, requestingUser, commentBody })
            break
    }

}


async function scheduleReminder({ context, commentReply, db, requestingUser, commentBody }) {
    const reminderObject = parseReminder(commentBody.split(' ').slice(1).join(' ').slice(1), context.payload.comment.created_at)

    if (!reminderObject) {
        commentReply.reply(`@${requestingUser} I didn't get that date.`)
        return
    }
     
    const reminderId = await db.addNewReminder(reminderObject, context)
    const date = new Date(reminderObject.when)


    const humanFriendlyTimeDelta = moment(date).fromNow()

    commentReply.reply(`I will remind ${reminderObject.who === 'me' ? 'you' : `\`${reminderObject.who}\``} of the following: "${reminderObject.what}" ${humanFriendlyTimeDelta}`)
    const job = schedule.scheduleJob(date, async () => await remind(reminderObject, reminderId, context, db))
    reminderIdToJob[reminderId] = job
}

async function listReminders({ commentReply, db, requestingUser }) {
    const remindersForUser = await db.getRemindersForUser(requestingUser)
    let remindersList = ""
    for (const reminder of remindersForUser) {
        const reminderObject = reminder.reminder_object
        remindersList += `
- Reminder **${reminder.id}**: 
    - **What:** ${reminderObject.what}
    - **Who:** ${reminderObject.who}
    - **When:** ${moment(new Date(reminderObject.when)).fromNow()}`
    }

    if (!remindersList) {
        commentReply.reply(`You have no reminders set.`)
        return
    }

    commentReply.reply(`## Your reminders ${remindersList}`)
}

async function remindHelp({ context, commentReply, db, requestingUser }) {
    commentReply.reply(`
## /remind help
- **help**: get this exact reply (e.g. \`/remind help \`)
- **list**: list all your active reminders (e.g. \`/remind list\`)
- **delete**: delete a reminder by ID (e.g. \`/remind delete 12\`)
- **define**: define an alias for a group of users (e.g. \`/remind define #engineering as @engineer1 @engineer2\`)
- **<username or group>**: set up a reminder for a user or group (e.g. \`/remind #engineering to do sprint planning on Tuesday at 4am\`)
`)
}

async function deleteReminder({ commentReply, db, requestingUser, commentBody }) {
    
    const id = Number(commentBody.split(' ')[3])
    let reminder = null
    try {
        reminder = await db.getReminderById(id)
    } catch (err) {
        commentReply.reply(`Error trying to delete reminder. The ID is probably invalid.`)
        return
    }

    if (!reminder) {
        commentReply.reply(`Reminder with ID ${id} doesn't exist.`)
        return
    }

    if (reminder.owner.trim() !== requestingUser) {
        console.log(reminder.owner.trim(), requestingUser.trim())
        commentReply.reply(`You can't delete a reminder you didn't create!`)
        return
    }

    try {
        reminderIdToJob[id].cancel() 
    } catch (err) {
        console.log(err)
    }
    await db.deleteReminder(id)

    commentReply.reply(`Reminder with ID ${id} deleted succesfully.`)

}

async function defineReminderGroup({ context, commentReply, db, requestingUser, commentBody }) {
    try {
        let [groupName, groupValue] = commentBody.split(' ').slice(3).join(' ').split(' as ')
        if (groupName[0] !== '#') {
            commentReply.reply(`Group names should start with a #.`)
            return
        }
        try {
            await db.createReminderGroup(groupName, groupValue)
        } catch (err) {
            commentReply.reply(`Failure creating group. It probably already exists.`)
            return
        }
        commentReply.reply(`Group \`${groupName}\` created succesfully as an alias for \`${groupValue}\``)

    } catch (error) {
        commentReply.reply(`Unable to handle request. Usage: \`@posthog-bot /remind define #team1 as @yakkomajuri @someonelse \``)
    }


}

async function remind(reminderObject, reminderId, context, db) {
    const requestingUser = context.payload.comment.user.login
    let reminderWho = reminderObject.who
    
    if (reminderWho === 'me') {
        reminderWho = `@${requestingUser}`
    } else if (reminderWho[0] === '#') {
        const groupValue = (await db.getReminderGroupByName(reminderWho)).group_value
        if (groupValue) {
            reminderWho = groupValue
        } 
    } else {
        reminderWho = `@${reminderWho}`
    }

    const cr = new CommentReply(context)
    cr.reply(
        `Hey ${reminderWho}! ${reminderObject.who === 'me' ? 'You' : `@${requestingUser}`} asked me to remind you of the following: "${reminderObject.what}"`
    )
    await cr.send(true)
    await db.deleteReminder(reminderId)
}


module.exports = { processIssueComment, processContribution, remind, reminderIdToJob }
