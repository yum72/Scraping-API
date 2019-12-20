const UserAgent = require('user-agents')

const getRandomuserAgent = () => {
    const userAgent = new UserAgent({ deviceCategory: 'desktop' })
    return userAgent.toString()
}

module.exports = getRandomuserAgent