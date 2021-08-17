module.exports = addContributor

const getUserDetails = require('./get-user-details')
const ContentFiles = require('./modules/content-files')

async function addContributor({
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
}) {
    // get user information
    const { id, login, name, avatar_url, profile } = await getUserDetails({
        octokit: context.octokit,
        username: who,
    })

    let merchNotification = ''

    if (isCodeContribution) {
        if (contributorEmail) {
            const emailComponents = contributorEmail.split('@')
            const maskedEmail = `${emailComponents[0].slice(0, 2)}*******@${emailComponents[1].slice(0, 2)}*******.***`
            merchNotification = `@${who} we sent you an email at ${maskedEmail} with a merch code as a thank you! If you don't have access to the email, message phil [at] posthog [.] com (@leggetter) and he'll sort it out!`
        } else {
            merchNotification = `@${who} we tried to send you an email with a merch code but that failed :( \nWe didn't give up on getting you some merch though, so email phil [at] posthog [.] com (@leggetter) and he'll send you a code!
      `
        }
    }

    if (config.isContributorWithRequestedContributionTypeAlreadyExists({ login: who, contributions })) {
        if (commentReply) {
            let message = merchNotification
                ? merchNotification
                : `@${who} already contributed before to ${contributions.join(', ')}`
            commentReply.reply(message)
        }

        return {}
    }

    // add user to configuration
    await config.addContributor({
        login: who,
        contributions,
        name,
        avatar_url,
        profile,
    })

    // fetch all files that are configured in .all-contributors.rc ("files" key)
    const contentFiles = new ContentFiles({
        repository,
    })

    await contentFiles.fetch(config)
    if (config.getOriginalSha() === undefined) {
        contentFiles.init()
    }
    contentFiles.generate(config)
    const filesByPathToUpdate = contentFiles.get()

    // add the `.all-contributorsrc` config file to list of files to update in PR
    filesByPathToUpdate[config.getPath()] = {
        content: config.getRaw(),
        originalSha: config.getOriginalSha(),
    }

    // PostHog:main or :master
    const requestOriginExplanation = commentReply
        ? `This was requested by ${commentReply.replyingToWho()} [in this comment](${commentReply.replyingToWhere()})`
        : `This is an automatic action triggered by the merging of [this PR](${pullRequestUrl}).`

    // create or update pull request
    const { pullRequestURL, pullCreated } = await repository.createPullRequestFromFiles({
        title: `🤖: Add ${who} as a contributor 🎉`,
        body: `Adds @${who} as a contributor for ${contributions.join(
            ', '
        )}.\n\n${requestOriginExplanation}\n\n${merchNotification}`,
        filesByPath: filesByPathToUpdate,
        branchName,
    })

    // let user know in comment
    const message = pullCreated
        ? `I've put up [a pull request](${pullRequestURL}) to add @${who}! :tada:`
        : `I've updated [the pull request](${pullRequestURL}) to add @${who}! :tada:`

    if (commentReply) {
        commentReply.reply(message)
    }

    return { pullRequestURL, pullCreated, user: { id, login } }
}
