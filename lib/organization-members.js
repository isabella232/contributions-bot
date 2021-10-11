const fetch = require('node-fetch')

class OrganizationMembers {
    constructor() {
        this.members = new Set()
        this.lastUpdatedAt = null
    }

    async init() {
        await this.#fetchUpdatedMembers()
    }

    async getOrganizationMembers() {
        const ONE_HOUR = 1000 * 60 * 60 * 1
        if (!this.lastUpdatedAt) {
            await this.#fetchUpdatedMembers()
        } else if (new Date().getTime - this.lastUpdatedAt > ONE_HOUR) {
            this.#fetchUpdatedMembers()
        }
        return this.members
    }

    async #fetchUpdatedMembers() {
        try {
            const githubOrgMembersResponse = await fetch('https://api.github.com/orgs/PostHog/members', {
                headers: {
                    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
                },
            })
            const githubOrgMembersJson = await githubOrgMembersResponse.json()
            const members = new Set([
                ...githubOrgMembersJson.map((member) => member.login),
                'posthog-contributions-bot[bot]',
                'dependabot',
                'dependabot[bot]',
                'posthog-bot',
                'dependabot-preview[bot]',
            ])
            members.delete('yakkomajuri')
            members.add('posthog-contributions-bot[bot]')
            this.members = members
            this.lastUpdatedAt = new Date().getTime()
        } catch {
            console.log('Unable to fetch organization members')
        }
    }
}

module.exports = {
    OrganizationMembers,
}
