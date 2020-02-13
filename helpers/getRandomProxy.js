const proxiesList = require('../constants/proxies')

const getRandomProxy = (proxyNum) => {
    let proxy = ''

    if (proxyNum && proxiesList && proxiesList[proxyNum]) { //return a selected proxy
        proxy = proxiesList[proxyNum]
    }
    else if (proxiesList.length) { //return random proxy
        proxy = proxiesList[Math.floor(Math.random() * proxiesList.length)].trim()
    }

    return proxy
}

module.exports = getRandomProxy