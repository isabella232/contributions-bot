class Database {
    constructor(postgresPool) {
        this.pool = postgresPool
    }

    async handleNewContribution(username) {
        const contributorExists = (
            await this.pool.query(`SELECT (username) FROM contributors WHERE username='${username}'`)
        ).rows.length

        let res = { querySucceeded: false, contributorLevel: 1 }
        if (contributorExists) {
            res.querySucceeded = !!(await this.#updateContributorLevel(username))
            if (res.querySucceeded) {
                res.contributorLevel = await this.#getContributorLevel(username)
            }
        } else {
            res.querySucceeded = !!(await this.#addNewContributor(username))
        }

        return res
    }

    async #addNewContributor(username) {
        const addNewContributorRes = await this.pool.query(`
            INSERT INTO contributors
            (username, level) 
            VALUES ('${username}', 1);
        `)

        return !!addNewContributorRes.rowCount
    }

    async #updateContributorLevel(username) {
        const updateContributorRes = await this.pool.query(`
            UPDATE contributors
            SET level = level + 1
            WHERE username='${username}';
    `)

        return !!updateContributorRes.rowCount
    }

    async #getContributorLevel(username) {
        const contributorLevelRes = await this.pool.query(`
            SELECT level FROM contributors
            WHERE username='${username}'
            LIMIT 1;
        `)

        return contributorLevelRes.rows[0].level
    }

    // 30 -> 50 on label
    async getGiftCardCode(username, giftCardLevel, mailer) {
        const useTestCodes = Boolean(process.env.USE_TEST_CODES) || username === 'yakkomajuri'
        const tableToUse = useTestCodes ? 'test_gift_cards' : 'gift_cards'

        const giftCardTokenRes = await this.pool.query(`
            SELECT token FROM ${tableToUse} 
            WHERE level=${giftCardLevel}
            AND has_been_used=false
            LIMIT 1;
        `)

        if (giftCardTokenRes.rowCount === 0) {
            return
        }

        const token = giftCardTokenRes.rows[0].token

        await this.pool.query(`
            UPDATE ${tableToUse}
            SET has_been_used=True,
            username='${username}',
            used_at=NOW()
            WHERE token='${token}';
        `)

        if (!useTestCodes) {

            this.pool.query(
                `
                SELECT COUNT(1) 
                FROM gift_cards 
                WHERE has_been_used=false 
                GROUP BY level;
            `,
                async (err, result) => {
                    if (err) {
                        await mailer.sendAlertEmail(`Unable to count gift cards left.`)
                        return
                    }
                    for (const row of result.rows) {
                        if (row.count <= 2) {
                            await mailer.sendAlertEmail(`Number of gift cards available is running low.`)
                            break
                        }
                    }
                }
            )
        }

        return token
    }
}

module.exports = {
    Database,
}
