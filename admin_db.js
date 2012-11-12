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

Usage
-----
http://localhost:5984/dbName/_admin_db?db_name=zzzz&action=create

http://localhost:5984/dbName/_admin_db?db_name=zzzz&action=drop

http://localhost:5984/dbName/_admin_db?action=set_roles&roles={user1 : [role1, role2], user2 : [role1, role2]}

http://localhost:5984/dbName/_admin_db?action=active_tasks

http://localhost:5984/dbName/_admin_db?action=set_public?public=true

http://localhost:5984/dbName/_admin_db?action=user_docs

*/

var couchdb = require('plantnet-node-couchdb'),
iniparser = require('iniparser'),
url = require('url');

var client;

process.on('uncaughtException', function(err, data) {
    error({'error' : err.stack || err.message});
});

// Validation functions

function valid_action_role(roles, action) {
    return roles.indexOf(action + 'db') >= 0 || roles.indexOf('_admin') >= 0;
}
    
function valid_db_name(param, action) {
    return !!param && param.slice(0,1) != '_';
}

function isDbAdmin(dbName, user, user_roles) {
    return user_roles.indexOf(dbName + '.admin') >=0 || user_roles.indexOf('_admin') >=0;
}

function isDbMember(dbName, user, user_roles) {
    dbName = dbName + '.';
    for (var i = 0; i < user_roles.length; i++) {
        var r = user_roles[i];
        if (r.slice(0, dbName.length) === dbName || r === '_admin') {
            return true;
        }
    }
    return false;
}

// Communication functions
function respond(data) {
    console.log(JSON.stringify({code: 200, json: data, headers: {}}));
}

function error(data) {
    console.log(JSON.stringify({code: 400, json: data, headers: {}}));
}

// Handlers
function getActiveTasks(srcDb, user, userRoles, query) {
    if (!isDbMember(srcDb, user, userRoles)) {
        error('not a db member');
    } else {
        client.activeTasks(
            function (err, data) {
                if (err) {
                    error(err); return;
                }
                data = data || [];
                
                data = data.filter(function (e) {
                    if(e.database && e.database === srcDb) {
                        e.details = 'db indexation';
                        return true;
                    }
                    
                    if (e.type === 'replication' && (e.source === srcDb || e.target === srcDb)) {
                        
                        var otherDb = e.source === srcDb ? e.target : e.source;
                        otherDb = url.parse(otherDb).pathname;
                        
                        e.details = 'synchronisation with ' + otherDb;
                        return true;
                    }
                    return false;
                });
                
                data = data.map(function (e) {
                    return {
                        type: e.type,
                        details: e.details,
                        progress: e.progress
                    };
                });
               
                respond(data);
            }
        );
    }
}

function setPublicDb(srcDb, user, user_roles, query) {
    var isPublic = query['public'] === 'true' || query['public'] === true;
    
    var rigths = {
        admins: {
            names: [],
            roles: [srcDb + '.admin']
        },
        members: {
            names: [],
            roles: isPublic ? [] : [srcDb + '.writer', srcDb + '.reader']
        }};

    var db = client.db(srcDb);
    db.saveDoc(
        '_security', 
        rigths, 
        function() {
            respond({
                status: 'ok',
                action: 'set_public',
                src_db: srcDb,
                'public': isPublic
            });
        });
}
    

function createDb(srcDb, userName, userRoles, query){
    var dstDb = query.db_name;
    if (!dstDb || !valid_db_name(dstDb, 'create')) {
        error({error: 'invalid db name'});
        return;
    }
    dstDb = dstDb.trim();

    if (!valid_action_role(userRoles, 'create')) {
        error({error: 'invalid role', user: userName, roles: userRoles});
        return;
    }

    var app_doc = '_design/datamanager';

    client.db(dstDb).create(function (err, data) {
        
        if (err) { error(err); return; }

        client.replicate(
            srcDb, 
            dstDb, 
            { doc_ids: [app_doc]}, 

            function(err, data) {
                if (err) {
                    err.src_db = srcDb;
                    err.dst_db = dstDb;
                    error(err);
                } else {
                    var db = client.db(dstDb),
                    dbName = dstDb,
                    rights = {
                        admins: {
                            names: [],
                            roles: [dbName + '.admin']
                        },
                        members: {
                            names: [],
                            roles: [dbName + '.writer', dbName + '.reader']
                        }
                    };
                db.saveDoc(
                    '_security', 
                    rights, 
                    function() {
                        
                        if(userName) {
                            setDbAdmin(
                                dstDb, 
                                userName, 
                                function() {
                                    
                                }
                            );
                        }
                        
                        respond({
                            status: 'ok',
                            action: 'create',
                            src_db: srcDb,
                            dst_db: dstDb
                        });
                    }
                );
                }
            });
    });
}


// return a list of user
function getUserAllDocs() {
    var userDb = client.db('_users');
    userDb.allDocs({
            startkey: 'org.couchdb.user:',
            endkey: 'org.couchdb.user:\ufff0',
            include_docs: true
        },
        function(err, data) {
            if (err) {
                error(err);
            } else {
                respond(data);
            }
        }); 
}

//set admin role for user for srcDb
function setDbAdmin(dbName, userName, cb) {
    var userDb = client.db('_users'),
    newrole = dbName + '.admin';
    
    userDb.getDoc(
        'org.couchdb.user:' + userName, 
        function(err, data) {
            if (err) { error(err); return; } 
            if (data.roles.indexOf(newrole) < 0) {
                data.roles.push(newrole);
                userDb.saveDoc(
                    data, 
                    function(err, data) {
                        if (err) { error(err); return; } 
                        cb();
                    }
                );
            } else {
                cb();
            }
        }
    );
}

function dropDb(srcDb, userName, userRoles, query) {
    var dbToRemove = query.db_name;
    dbToRemove = dbToRemove.trim();
    
    if (!dbToRemove || !valid_db_name(dbToRemove, 'drop')) {
        error({error: 'invalid db name'});
    } else if (!valid_action_role(userRoles, 'drop')) {
        error({error: 'invalid role', user: userName, roles: roles});
    } else if (isDbAdmin(dbToRemove, userName, userRoles)) {
        var db = client.db(dbToRemove).remove(
            function() {
                var rolesToClean = [dbToRemove + '.admin', dbToRemove + '.writer', dbToRemove + '.reader'];
                cleanRoles(srcDb, rolesToClean);
                respond({
                    status: 'ok',
                    action: 'drop',
                    src_db: srcDb,
                    dst_db: dbToRemove
                });
            });
    } else {
        error({error: 'user is not a db admin', user: userName, roles: userRoles});
    }
}

// http://localhost:5984/dbName/_admin_db?action=set_roles&roles={user1 : [role1, role2], user2 : [role1, role2]}
function setRoles(srcDb, userName, userRoles, query) {
    if (!isDbAdmin(srcDb, userName, userRoles)) {
        error({error: 'user is not a db admin', user: userName, roles: userRoles});
        return;
    }

    var roles = query.roles;
    try {
        roles = JSON.parse(roles);
    } catch (x) {
        error({error: 'invalid roles param : ' + x + ' ' + roles});
    }

    var userDb = client.db('_users');

    // get user to edit
    var userkeys = []; 
    for (var u in roles) {
        userkeys.push('org.couchdb.user:' + u);
    }
   
    // get all user docs
    userDb.allDocs(
        {
            include_docs: true,
            keys: JSON.stringify(userkeys)
        }, 
        function(err, data) {
            if (err) {
                error(err);
            } else {
                var newDocs = [];
                data.rows.forEach(
                    function(e) {
                        var userDoc = e.doc,
                        userRoles = roles[userDoc.name];
                        if (userRoles) {
                            userRoles.forEach(
                                function(e) {
                                    var dbNameRole = e.substring(0, e.indexOf('.', 0)), // dbname
                                        roleSuffix = e.slice(dbNameRole.length + 1),
                                        haveRole = (userDoc && userDoc.roles.indexOf(e) >= 0);

                                    // we can have only one dbname.role in role
                                    if (!haveRole) {
                                        // for each existing role
                                        for (var roleIdx = 0; roleIdx < userDoc.roles.length; roleIdx++) {
                                            var role = userDoc.roles[roleIdx];
                                            // we remove the role with the same dbname
                                            if (role.indexOf(dbNameRole) == 0) { 
                                                userDoc.roles.splice(roleIdx, 1);
                                            }
                                        }
                                        if (roleSuffix != 'exclude') {
                                            userDoc.roles.push(e);
                                        }
                                    }
                                });
                            newDocs.push(userDoc);
                        }
                    }
                ); // end for each
                userDb.bulkDocs(
                    {docs : newDocs}, 
                    function () {
                        respond({
                            status: 'ok',
                            action: 'set_roles',
                            src_db: srcDb,
                            roles: roles 
                        });
                    }
                );
            }
        }
    );
}

//http://localhost:5984/dbName/_admin_db?action=clean_roles&roles=[role1, role2]
function cleanRoles(srcDb, rolesToClean) {
    var userDb = client.db('_users');
    userDb.allDocs(// get all user docs
        {include_docs: true}, 
        function(err, data) {
            if (err) {
                error(err);
            } else {
                var newDocs = [];
                data.rows.forEach(
                    function(e) {
                        var userDoc = e.doc,
                        userRoles = userDoc.roles;
                        if (userRoles) {
                            rolesToClean.forEach(
                                function(role) {
                                    var roleIdx = userRoles.indexOf(role);
                                    
                                    if (roleIdx >= 0) {
                                        userDoc.roles.splice(roleIdx, 1);
                                    }
                                });
                            newDocs.push(userDoc);
                        }
                    }
                ); // end for each
                userDb.bulkDocs(
                    {docs: newDocs}, 
                    function () {
                        respond({
                            status: 'ok',
                            action: 'clean_roles',
                            src_db: srcDb,
                            roles: rolesToClean 
                        });
                    }
                );
            }
        }
    );
}



function process_query(action, srcDb, userName, userRoles, query) {
    var actionMap = {
        create : createDb,
        drop : dropDb,
        set_roles : setRoles,
        active_tasks : getActiveTasks,
        user_docs : getUserAllDocs,
        set_public : setPublicDb
    };

    var handler = actionMap[action];
    if (!handler) {
        error("unknown action"); return;
    }

    handler(srcDb, userName, userRoles, query);
}

function process_req(req) {
    var srcDb = req.info.db_name,
    userName = req.userCtx.name,
    roles = req.userCtx.roles,
    action = req.query.action;

    if (!action) {
        error({error: 'invalid action'});
    } else {
        process_query(action, srcDb, userName, roles, req.query);
    }
}

function main () {
    
    try {
        // get config
        var config = iniparser.parseSync(__dirname + '/admin_db.ini');
        client = couchdb.createClient(config.port, config.host, config.login, config.password);
    } catch (Exception) {}
    
    if(!client) {
        client = couchdb.createClient("5984", "localhost");
    }

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

main();                               