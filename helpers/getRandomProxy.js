const proxiesList = require('../constants/proxies')

const getRandomProxy = () => {
    let proxy = ''

    if (proxiesList.length) {
        proxy = proxiesList[Math.floor(Math.random() * proxiesList.length)].trim()
    }

    return proxy
}

module.exports = getRandomProxy