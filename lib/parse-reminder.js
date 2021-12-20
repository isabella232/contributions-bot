const chrono = require('chrono-node')
const matcher = /^remind @?([^\s]+)(?: to )?([\s\S]*)$/

/*

Modified from https://github.com/bkeepers/parse-reminder

Original License:

-----

ISC License

Copyright (c) 2017 Brandon Keepers

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

-----
*/


function parseReminder(input, from) {
    const match = input.match(matcher)
    if (!match) {
        return null
    }

    let [, who, what] = match


    const parsedWhen = chrono.parse(what, from)
    const when = parsedWhen.length > 0 ? parsedWhen[0].start.date() : null

    if (!when) {
        return null
    }

    if (when.length < 1) {
        return null
    }

    what = what.replace(parsedWhen[0].text, '')

    what = what.trim()
    what = what.replace(/^(to|that) /, '').replace(/ on$/, '')

    return { who, what, when }
}

module.exports = { parseReminder }