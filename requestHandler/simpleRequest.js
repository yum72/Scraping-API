const request = require('request')

const getRandomProxy = require('../helpers/getRandomProxy')
const getRandomuserAgent = require('../helpers/getRandomuserAgent')

const handleRequest = (url) => {

    let options = {
        url: url,
        method: 'GET',
        headers: {
            'User-Agent': getRandomuserAgent(),
        },
        proxy: getRandomProxy(),
        strictSSL: false,
        timeout: 30000,
        followAllRedirects: true,
    }

    return new Promise((resolve, reject) => {
        try {
            request(options, (error, response, html) => {
                if (error) {
                    resolve(error)
                }
                else if (response && response.statusCode < 400 && html) {
                    resolve(html)
                }
                else {
                    reject(response.statusCode)
                }
            })
        }
        catch (e) {
            console.log(e)
            reject(e)
        }
    })
}

module.exports = handleRequest