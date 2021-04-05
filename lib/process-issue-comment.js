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
const P = require('pino')

async function processIssueComment({ context, commentReply, db }) {
  const commentBody = context.payload.comment.body
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

async function processContribution({ who, contributions, log, context, commentReply = '', db, pullRequestUrl, extraMerch = false }) {
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
    errorMessage
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
    errorMessage: ''
  }

  // Only send merch automatically to those who contribute code
  if (!isCodeContribution) {
    return defaultResponse
  }

  contributorUpdateQueryRes = await db.handleNewContribution(who)
  defaultResponse.contributorUpdateQueryRes = contributorUpdateQueryRes

  // Handle Postgres query failures
  if (!contributorUpdateQueryRes.querySucceeded) {
    let res = {...defaultResponse}
    res.errorMessage = 'Could not complete contributor update query.'
    return res
  }

  const giftCardLevel = extraMerch ? 2 : 1

  const giftCardCode = await db.getGiftCardCode(who, giftCardLevel, mailer)

  // No gift card available or query failed
  if (!giftCardCode) {
    let res = {...defaultResponse}
    res.errorMessage = 'Could not get a gift card code from the database.'
    return res
  }

  contributorEmail = await getEmailFromGithubUsername(who)

  // Unable to get an email from GitHub using the public events method
  if (!contributorEmail) {
    let res = {...defaultResponse}
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
    let res = {...defaultResponse}
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

  let res = {...defaultResponse}
  res.sendMerchSucceeded = true

  return res
}

module.exports = { processIssueComment, processContribution }

