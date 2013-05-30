#!/usr/bin/nodejs
/*
Admin db services

CouchDB Configuration 
---------------------

[external]
admin_db = node PATH_TO/admin_db.js

[httpd_db_handlers]
_admin_db = {couch_httpd_external, handle_external_req, <<"admin_db">>}


local Configuration
-------------------

create a file admin_db.ini in the same directory

login=login
password=pwd
host=localhost
port=5984


system Configuration - better than local configuration
-------------------

create a file admin_db.ini in /opt/datamanager/dm-admin.ini with the same contents


Usage
-----
http://localhost:5984/dbName/_admin_db?db_name=zzzz&action=create

http://localhost:5984/dbName/_admin_db?db_name=zzzz&action=drop

http://localhost:5984/dbName/_admin_db?action=set_roles&roles={user1 : [role1, role2], user2 : [role1, role2]}

http://localhost:5984/dbName/_admin_db?action=active_tasks

http://localhost:5984/dbName/_admin_db?action=set_public?public=true

http://localhost:5984/dbName/_admin_db?action=user_docs

*/

var admin = require("./admin")


// Communication functions
function respond(data) {
    console.log(JSON.stringify({code: 200, json: data, headers: {}}));
}

function error(data) {
    console.log(JSON.stringify({code: 400, json: data, headers: {}}));
}



function process_req(req) {
    var srcDb = req.info.db_name,
        userName = req.userCtx.name,
        roles = req.userCtx.roles,
        action = req.query.action,
        query = req.query;

    // merge POST and GET parameters
    if (req.method == 'POST') {
        var postParams = JSON.parse(req.body);
        for (var key in postParams) {
            if (! (key in query)) { // GET params get the priority
                query[key] = postParams[key];
            }
        }
    }

    if (!action) {
        error({error: 'invalid action'});
    } else {
        admin.process_query(action, srcDb, userName, roles, query);
    }
}

function main () {
    
    admin.init(respond, error);
    // test
    //  process_req({
    //     info : {db_name : "datamanager"},
    //     userCtx : { name : "sdufour", roles : ["createdb"]},
    //     query : { action : 'create', db_name: 'abcd'}
    // })

    // stdin callback to communicate with couchdb
    process.stdin.resume();
    process.stdin.on('data', function(d) {
        process_req(JSON.parse(d));
    });

    process.stdin.on('end', function () {
        process.exit(0);
    });
}

process.on('uncaughtException', function(err, data) {
    error({'error' : err.stack || err.message});
});

main();