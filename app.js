const Koa = require('koa')
const router = require('koa-router')()
const koaBody = require('koa-body')

const runJob = require('./requestHandler/jsEnabledRequest')

const app = module.exports = new Koa()

const IS_PRODUCTION = process.env.NODE_ENV === 'production'
const secretAPIKey = '1234' //secret api key

app.use(koaBody())

router.get('/user', userRequest)
    .get('/', hello)
//.get('/free', freeRequest)

async function freeRequest(ctx) {
    ctx.body = 'freeRequest'
}

async function hello(ctx) {
    ctx.body = 'Hello'
}

async function userRequest(ctx) {

    let apiKey = ctx.request.headers['api-key']
    let url = ctx.request.headers['url']

    if (!apiKey) {
        ctx.status = 401
        ctx.body = 'api-key header required for authentication'
    }
    else if (apiKey == secretAPIKey) {
        if (url) {
            try {
                let response = await runJob(url, IS_PRODUCTION)
                ctx.body = response
            } catch (error) {
                ctx.body = error
            }
        }
        else {
            ctx.body = 'Missing Header url'
        }
    }
    else {
        ctx.status = 401
        ctx.body = 'Invalid API key'
    }
}

if (!module.parent) {
    app.use(router.routes())
    app.use(router.allowedMethods())
    app.listen(3000)
    console.log('app listening on 3000')
}