const Koa = require('koa')
const router = require('koa-router')()
const koaBody = require('koa-body')

const app = module.exports = new Koa()

let secretAPIKey = '1234' //secret api key

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
    if (!apiKey) {
        ctx.status = 401
        ctx.body = 'api-key header required for authentication'
    }
    else if (apiKey == secretAPIKey) {
        ctx.body = 'userRequest'
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