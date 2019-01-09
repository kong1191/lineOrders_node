const express = require('express');
const linebot = require('linebot');
var app = module.exports = express();

const bot = linebot({
    channelId: process.env.CHANNEL_ID,
    channelSecret: process.env.CHANNEL_SECRET,
    channelAccessToken: process.env.CHANNEL_TOKEN
});

const linebotParser = bot.parser();

// Redirect linebot webhook url to linebot parser
app.post('/linewebhook', linebotParser);

const join_message = '謝謝邀請我加入群組，讓我有機會服務大家～';

bot.on('join', function(event) {
    event.reply(join_message).then(function(data) {
        console.debug('Success to reply join event');
    }).catch(function(error) {
        console.error('Failed to reply join event', error);
    });
});

bot.on('message', function(event) {
    event.reply(event.message.text).then(function (data) {
        console.debug('Success to reply message event', data);
    }).catch(function(error) {
        console.error('Failed to reply message event', error);
    });
});

//Express API --------- App.get('path', callback function);
//routes HTTP GET requests to the specified path with the specified callback functions
app.get('/', function(request, response) {
    response.json({ message: 'response from node service!' });
});

app.post('/ajax', function(request, response) {
    response.send("response by ajax");
});
