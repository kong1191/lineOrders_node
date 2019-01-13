const express = require('express');
const linebot = require('linebot');
const {google} = require('googleapis');
const fs = require('fs');
const streamifier = require('streamifier');
const path = require('path');
const request = require('request-promise');
const winston = require('winston');
var app = module.exports = express();

// Console transport for winton.
const consoleTransport = new winston.transports.Console();

// Set up winston logging.
const logger = winston.createLogger({
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.simple()
  ),
  transports: [
    consoleTransport
  ]
});

// Log Levels:
// error: 0, warn: 1, info: 2, verbose: 3, debug: 4, silly: 5
if (process.env.LOG_LEVEL) {
    logger.level = process.env.LOG_LEVEL;
} else {
    logger.level = 'warn';
}

const download_path = path.join(__dirname, 'download');
fs.mkdir(download_path, function(err) {
    // Ignore file existed error
    if (err && err.errno != -17) {
        logger.error("Failed to creating download folder", err);
    }
});

const google_auth_client = new google.auth.OAuth2(
    process.env.OAUTH_CLIENT_ID,
    process.env.OAUTH_CLIENT_SECRET,
    process.env.OAUTH_REDIRECT_URL
);

google_auth_client.setCredentials({
    "refresh_token": process.env.OAUTH_REFRESH_TOKEN
});

async function get_access_token() {
    var tokens = await google_auth_client.getAccessToken();
    logger.debug("Get access token: ", tokens.token);
    return tokens.token;
}

// generate a url that asks permissions for Photo Library sharing scopes
const scopes = [
    'https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata',
    'https://www.googleapis.com/auth/photoslibrary.sharing'
];

const auth_url = google_auth_client.generateAuthUrl({
    // 'online' (default) or 'offline' (gets refresh_token)
    access_type: 'offline',

    // If you only need one scope you can pass it as a string
    scope: scopes.join(' ')
});

app.get('/auth/google', function(request, response) {
    response.redirect(auth_url);
});

app.get('/auth/google/callback', function(request, response) {
    if (request.query && request.query.error) {
        logger.error("Authentication failed", request.query.error);
        response.send("Authentication Failed");
    } else {
        var code = request.query.code;
        google_auth_client.getToken(code, function(err, tokens) {
            if (err) {
                logger.error("Failed to get tokens from Authentication Server", err);
                response.send("Failed to get tokens from Authentication Server");
            } else {
                logger.info("Get tokens", tokens);

                google_auth_client.setCredentials(tokens);
                response.send("Authentication Success!");
            }
        });
    }
});

// TODO(james): retrive album info from database
const default_album_id = "ALv8aGRWyA0U11qF7_cz4OQb0K529I4tgW2Xxp2JMm93HHulBVljmGxofo-S4Ipxs5xI3Orr6Pvx";
const default_album_shared_link = "https://photos.app.goo.gl/pdjhnP3Nqp5bK8Vw7";

app.get('/albums', async(req, res) => {
    const token = await get_access_token();

    const data = await get_shared_albums(token);
    if (data.error !== null) {
        res.status(500).send(data.error);
    } else {
      res.status(200).send(data.albums);
    }
});

app.post('/album/:title', async(req, res) => {
    const token = await get_access_token();

    const error = await create_shared_album(token, req.params.title);
    if (error) {
      res.status(500).send(error);
    } else {
      res.status(200).send('Create album success');
    }
});

app.post('/upload/:filename', async(req, res) => {
    const token = await get_access_token();

    const file_name = req.params.filename;
    const file_path = path.join(download_path, file_name);
    if (!fs.existsSync(file_path)) {
        res.status(500).send({name: 'File operation error', message: "File does not existed"});
        return;
    }

    var item = {
        "name": file_name,
        "stream": fs.createReadStream(file_path)
    };

    const error = await upload_media_item(token, default_album_id, item);
    if (error) {
      res.status(500).send(error);
    } else {
      res.status(200).send('Upload media item success');
    }
});

async function create_shared_album(token, title) {
    let error = null;

    var result = await request.post('https://photoslibrary.googleapis.com/v1/albums', {
      headers: {'Content-Type': 'application/json'},
      json: true,
      auth: {'bearer': token},
      body: {
        "album": {
          "title": title
        }
      }
    }).catch(function (err) {
        error = {name: err.name, message: err.message};
        logger.error('Failed to create new album', error);
    });

    if (error !== null) {
        return error;
    }

    logger.debug('Response of creating album:', result);
    album_id = result.id;

    result = await request.post(`https://photoslibrary.googleapis.com/v1/albums/${album_id}:share`, {
        headers: {'Content-Type': 'application/json'},
        json: true,
        auth: {'bearer': token},
        body: {
            "sharedAlbumOptions": {
              "isCollaborative": true,
              "isCommentable": true
            }
        }
    }).catch(function (err) {
        error = {name: err.name, message: err.message};
        logger.error('Failed to share new album', error);
    });

    if (error === null) {
        logger.debug('Response of sharing album:', result);
    }
    return error;
}

// Returns a list of all albums owner by the logged in user from the Library
// API.
async function get_shared_albums(authToken) {
    let albums = [];
    let nextPageToken = null;
    let error = null;
    let parameters = {
      pageSize: 10,
      excludeNonAppCreatedData: false
    };

    // Loop while there is a nextpageToken property in the response until all
    // albums have been listed.
    do {
        logger.debug(`Loading shared albums. Received so far: ${albums.length}`);
        // Make a GET request to load the albums with optional parameters (the
        // pageToken if set).
        const result = await request.get('https://photoslibrary.googleapis.com/v1/sharedAlbums', {
            headers: {'Content-Type': 'application/json'},
            qs: parameters,
            json: true,
            auth: {'bearer': authToken},
        }).catch(function (err) {
            error = {name: err.name, message: err.message};
            logger.error('Failed to get album list', error);
        });

        if (error !== null) {
            return {albums, error};
        }

        logger.debug('Response:', result);

        if (result && result.sharedAlbums) {
            logger.debug(`Number of albums received: ${result.sharedAlbums.length}`);
            // Parse albums and add them to the list, skipping empty entries.
            const items = result.sharedAlbums.filter(x => !!x);

            albums = albums.concat(items);
        }
        parameters.pageToken = result.nextPageToken;
        // Loop until all albums have been listed and no new nextPageToken is
        // returned.
    } while (parameters.pageToken);

    logger.info('Albums loaded.');
    return {albums, error};
}

async function upload_media_item(token, album_id, item) {
    let error = null;

    var result = await request.post('https://photoslibrary.googleapis.com/v1/uploads', {
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Goog-Upload-File-Name': item.name,
        'X-Goog-Upload-Protocol': 'raw'
      },
      json: false,
      auth: {'bearer': token},
      body: item.stream
    }).catch(function (err) {
        error = {name: err.name, message: err.message};
        logger.error('Failed to upload media item', error);
    });

    if (error !== null) {
        return error;
    }

    logger.debug('Response of uploading media item:', result);
    var upload_token = result;

    result = await request.post(`https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate`, {
        headers: {'Content-Type': 'application/json'},
        json: true,
        auth: {'bearer': token},
        body: {
            "albumId": album_id,
            "newMediaItems": [
              {
                "description": "",
                "simpleMediaItem": {
                  "uploadToken": upload_token
                }
              }
            ]
        }
    }).catch(function (err) {
        error = {name: err.name, message: err.message};
        logger.error('Failed to add media item to album', error);
    });

    if (error === null) {
        logger.debug('Response of creating media item:', result);
    }
    return error;
}

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
        logger.debug('Success to reply join event');
    }).catch(function(error) {
        logger.error('Failed to reply join event', error);
    });
});

var enable_broadcast = true;

var menu_pattern = new RegExp("服務(台|臺)");

var menu_message = {
    quickReply: {
        items: [
            {
                type: "action",
                action: {
                    type: "postback",
                    label: "開啟推播",
                    data: "enable_broadcast",
                    displayText: "開啟推播"
                }
            },
            {
                type: "action",
                action: {
                    type: "postback",
                    label: "關閉推播",
                    data: "disable_broadcast",
                    displayText: "關閉推播"
                }
            },
            {
                type: "action",
                action: {
                    type: "message",
                    label: "相簿連結",
                    text: default_album_shared_link,
                }
            }
        ]
    },
    type: "text",
    text: "您好，請問需要什麼服務?"
};

bot.on('postback', function(event) {
    if (event.postback.data === "enable_broadcast") {
        enable_broadcast = true;
    } else if (event.postback.data === "disable_broadcast") {
        enable_broadcast = false;
    } else {
        logger.error('Unkown postback event data', event.postback);
    }
});

function handle_text_message(text) {
    if (menu_pattern.test(text)) {
        return menu_message;
    }

    return null;
}

async function upload_to_google_photo(type, msg_id) {
    const buffer = await bot.getMessageContent(msg_id);

    var item = {
        "name": `${type}-${msg_id}`,
        "stream": streamifier.createReadStream(buffer)
    };

    logger.info('Start uploading content to Google Photo:', item.name);

    // Upload content to Google Photo
    // TODO(james): query album id from database according to group ID or room ID
    const token = await get_access_token();
    const error = await upload_media_item(token, default_album_id, item);
    if (error) {
      logger.error('Failed to upload file to album', error);
    } else {
      logger.info(`Upload media item success: ${item.name}`);
    }
}

bot.on('message', function(event) {
    var reply_message = null;

    switch (event.message.type) {
        case "text":
            reply_message = handle_text_message(event.message.text);
            break;
        case "image":
        case "video":
            if (event.message.contentProvider.type === "line") {
                upload_to_google_photo(event.message.type, event.message.id);
            }
            break;
        default:
            logger.error('Unkown message type', event.message.type);
    }

    if (reply_message === null) {
        return;
    }

    event.reply(reply_message).then(function(data) {
        logger.debug('Success to reply message event');
    }).catch(function(error) {
        logger.error('Failed to reply message event', error);
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
