const puppeteer = require('puppeteer-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')

puppeteer.use(StealthPlugin())

const getRandomProxy = require('../helpers/getRandomProxy')
// const getRandomuserAgent = require('../helpers/getRandomuserAgent')

const runJob = (url, IS_PRODUCTION) => {
    return new Promise(async (resolve, reject) => {
        let proxy = getRandomProxy()
        // let userAgent = getRandomuserAgent()

        const browser = IS_PRODUCTION ?
            await puppeteer.connect({
                browserWSEndpoint:
                    'ws://' +
                    browserless.ip +
                    ':' +
                    browserless.port +
                    '?TOKEN=' +
                    browserless.token +
                    (proxy != '' ? '&--proxy-server=' + proxy : '') +
                    '&--no-sandbox=true' +
                    '&--disable-setuid-sandbox=true' +
                    '&--disable-dev-shm-usage=true' +
                    '&--disable-accelerated-2d-canvas=true' +
                    '&--disable-gpu=true'
            }) :
            await puppeteer.launch({
                headless: false,
                args: [
                    (proxy != '' ? '--proxy-server=' + proxy : ''),
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--disable-gpu'
                ],
            })

        const blockedResourceTypes = [
            'image',
            'media',
            'font',
            'texttrack',
            'object',
            'beacon',
            'csp_report',
            'imageset',
        ]

        const skippedResources = [
            'quantserve',
            'adzerk',
            'doubleclick',
            'adition',
            'exelator',
            'sharethrough',
            'cdn.api.twitter',
            'google-analytics',
            'googletagmanager',
            'google',
            'fontawesome',
            'facebook',
            'analytics',
            'optimizely',
            'clicktale',
            'mixpanel',
            'zedo',
            'clicksor',
            'tiqcdn',
        ]

        try {

            const page = await browser.newPage()
            // await page.setUserAgent(userAgent)

            //******* Causes Bot Detection on some Sites*********//

            // await page.setRequestInterception(true)
            // page.on('request', request => {
            //     const requestUrl = request._url.split('?')[0].split('#')[0]
            //     if (
            //         blockedResourceTypes.indexOf(request.resourceType()) !== -1 ||
            //         skippedResources.some(resource => requestUrl.indexOf(resource) !== -1)
            //     ) {
            //         request.abort()
            //     } else {
            //         request.continue()
            //     }
            // })

            const response = await page.goto(url, {
                timeout: 25000,
                waitUntil: 'networkidle2',
            })

            if (response._status < 400) {
                await page.waitFor(1000)
                let html = await page.content()
                resolve(html)
            }
            else {
                await page.goto('https://bot.sannysoft.com')
                await page.waitFor(50000)
                reject('Status Code: ' + response._status)
            }

        } catch (error) {
            reject(error)
        } finally {
            if (browser) {
                browser.close()
            }
        }
    })

}

module.exports = runJob