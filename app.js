const isMessageByApp = require('./lib/is-message-by-app')
const isMessageForApp = require('./lib/is-message-for-app')
const CommentReply = require('./lib/modules/comment-reply')
const { processIssueComment, processContribution } = require('./lib/process-issue-comment')
const { pullRequestContainsLabel } = require('./lib/utils')
const { AllContributorBotError } = require('./lib/modules/errors')
const { OrganizationMembers } = require('./lib/organization-members')
const { Database } = require('./lib/database')
const { Pool } = require('pg')
const probot = require('probot')
const Sentry = require("@sentry/node");

Sentry.init({
    dsn: "https://9613246c10b542d79ff183c9a5ee218e@o1015702.ingest.sentry.io/5986857",
  
    // Set tracesSampleRate to 1.0 to capture 100%
    // of transactions for performance monitoring.
    // We recommend adjusting this value in production
    tracesSampleRate: 1.0,
  });

/** At how many comments should the bot complain about the issue dragging on. */
const ISSUE_TOO_LONG_COMMENTS_TRESHOLD = 10

const postgresPool = process.env.DEBUG
    ? new Pool({ database: 'ph-allc' })
    : new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

const db = new Database(postgresPool)

const organizationMembers = new OrganizationMembers()

class ProbotServer {
    constructor(app) {
        this.app = app
        this.probotServer = null
    }

    async startServer() {
        console.log('Starting Probot server...')
        this.probotServer = await probot.run(this.app)
    }

    async stopServer() {
        if (this.probotServer) {
            console.log('\nGracefully shutting down Probot server...')
            await this.probotServer.stop()
        }
    }
}

async function handleGeneralMessage(context) {
    const allComments = await context.octokit.issues.listComments()
    const filteredComments = allComments.data.filter(comment => !comment.user || !comment.user.login.includes('[bot]'))
    if (filteredComments.length >= ISSUE_TOO_LONG_COMMENTS_TRESHOLD) {
        const commentReply = new CommentReply(context)
        commentReply.reply(
        `This issue has **${comment_count}** comments. Issues this long are very hard to read _or_ to contribute to, and tend to take very long to reach a conclusion. Instead, why not:
1. Write some code and **submit a pull request**! Code wins arguments
2. **Have a sync meeting** to reach a conclusion
3. **Create a request for comments** in the [meta repo](https://github.com/PostHog/meta/blob/main/requests-for-comments/1970-01-01-template.md) or [product internal repo](https://github.com/PostHog/product-internal/new/main/requests-for-comments)`
        )
        commentReply.send(true)
    } 
}

async function handleMessageIntendedForBot(context) {
    const members = await organizationMembers.getOrganizationMembers()

    // Only org members can request contributors be added
    const userWhoWroteComment = context.payload.sender.login

    if (userWhoWroteComment !== 'yakkomajuri' && !members.has(userWhoWroteComment)) {
        return
    }

    const repoOwner = context.payload.repository.owner.login

    if (process.env.ALLOWED_ORGS && !process.env.ALLOWED_ORGS.split(',').includes(repoOwner)) {
        return
    }


    // process comment and reply
    const commentReply = new CommentReply(context)
    try {
        await processIssueComment({ context, commentReply, db })
    } catch (error) {
        const isKnownError = error instanceof AllContributorBotError
        if (!isKnownError) {
            commentReply.reply(`We had trouble processing your request. Please try again later.`)

            throw error
        }

        context.log.info({ isKnownError, error: error.name }, error.message)
        commentReply.reply(error.message)
    } finally {
        await commentReply.send()
    }
}

const probotServer = new ProbotServer((app) => {
    app.on('issue_comment.created', async (context) => {
        if (isMessageByApp(context)) return
        if (isMessageForApp(context)) {
            handleMessageIntendedForBot(context)
        } else {
            handleGeneralMessage(context)
        }
    })

    app.on('pull_request.closed', async (context) => {
        const pullRequest = context.payload.pull_request

        const repoOwner = pullRequest.base.repo.owner.login

        if (process.env.ALLOWED_ORGS && !process.env.ALLOWED_ORGS.split(',').includes(repoOwner)) {
            return
        }


        const members = await organizationMembers.getOrganizationMembers()
        const who = pullRequest.user.login

        /*
        *  Do not add contributor if:
        *  - PR was closed but not merged
        *  - Username is part of the PostHog org
        *  - PR is to a non-default branch
        */
        if (!pullRequest.merged || members.has(who) || !/:(main|master)/.test(pullRequest.base.label)) {
            return
        }

        const log = context.log.child({
            who,
            action: 'add',
            contributions: ['code'],
        })

        try {
            await processContribution({
                who,
                log,
                db,
                contributions: ['code'],
                context: context,
                pullRequestUrl: pullRequest.html_url,
                extraMerch: pullRequestContainsLabel(pullRequest, 'extra merch')
            })
        } catch (error) {
            const isKnownError = error instanceof AllContributorBotError
            context.log.info({ isKnownError, error: error.name }, error.message)
        }
    })

    app.on(['installation', 'installation_repositories'], async ({ name, payload, log }) => {
        const { action, repositories, repositories_added, repositories_removed, installation } = payload

        const repositoriesChange =
            action === 'created'
                ? repositories.length
                : action === 'deleted'
                    ? -repositories.length
                    : repositories_added
                        ? repositories_added.length - repositories_removed.length
                        : 0

        const meta = {
            event: name,
            action,
            account: installation.account.id,
            accountType: installation.account.type.toLowerCase(),
            accountLogin: installation.account.login,
            installation: installation.id,
            selection: installation.repository_selection,
            repositoriesChange,
        }
        log.info(meta, `${meta.accountLogin}: ${name} ${action}`)
    })
})

probotServer.startServer()

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, async () => {
        await probotServer.stopServer()

        console.log('Gracefully shutting down Postgres pool...')
        await postgresPool.end()
    })
}
