module.exports = function(RED) {
    "use strict";
    var request = require("request");
    var querystring = require("querystring");
    var CronJob = require('cron').CronJob;
    /*
    Setup MonzoCredentialsNode
     */
    function MonzoCredentialsNode(n) {
        RED.nodes.createNode(this, n);
        this.cronjob = null;
        var node = this;

        /*
        Set up cron job and add it to node object so it can be stopped upon node close.
         */
        this.cronjob = new CronJob('1 */60 * * * *', function() { // Cron Job Once Per Hour, This Needs to be vairable later on.
            const Monzo = require('monzo-js');
            console.log("[monzo] - node id: " + node.id);
            var creds = RED.nodes.getCredentials(node.id);
            var secret = creds.secret;
            var clientid = creds.client_id;
            var refreshtoken = creds.refreshtoken;
            if (refreshtoken != "" && refreshtoken != undefined) {
                console.log("[monzo] - refreshing token\nOld Refresh Token: " + refreshtoken + "\nSecret: " + secret + "\nClient id:" + clientid);

                /*
                Using monzojs, refresh the token and retreive the access_token and refresh_token
                 */
                Monzo.OAuth.refreshToken(clientid, secret, refreshtoken).then(({
                    access_token,
                    refresh_token
                }) => {
                    if (access_token) {
                        console.log("[monzo] - refresh complete \nRefresh Token: " + refresh_token + "\nAccess Token: " + access_token + "\nSecret:" + secret + "\nClient id: " + clientid );
                        var credentials = {
                            client_id: clientid,
                            secret: secret,
                            token: access_token,
                            refreshtoken: refresh_token
                        };
                        RED.nodes.addCredentials(node.id, credentials);
                    } else {
                        console.log("[monzo] - refresh failed");
                    }
                }).catch(error => {
                    console.log("[monzo] - refresh failed, needs reauthenticating - " + error + "\n\n" + JSON.stringify(error));
                });
            } else {
                //no refresh token dont bother trying to refresh it.
                console.log("[monzo] - no refresh token dont bother trying to refresh it.");
            }
        }, null, true, 'America/Los_Angeles');
    }

    /*
    Upon node close i.e when node-red closes or a user redeploys the flow, stop the cronjob and remove it.
     */
    MonzoCredentialsNode.prototype.close = function() {
        this.cronjob.stop();
        delete this.cronjob;
    };

    /*
    Register the monzo credentials node along with the credentials it will need.
     */
    RED.nodes.registerType("monzo-credentials", MonzoCredentialsNode, {
        credentials: {
            client_id: {
                type: "text"
            },
            secret: {
                type: "text"
            },
            token: {
                type: "text"
            },
            refreshtoken: {
                type: "text"
            },
            redirect_uri:{
                type: "text"
            }
        }
    });

    /*
    Set up endpoint so that we can set the client id and secret when we press authorise with monzo
     */
    RED.httpAdmin.get('/monzo-creds-set', function(req, res) {
        var secret = req.query.secret;
        var clientid = req.query.clientid;
        var nodeid = req.query.nodeid;
        var redirect = req.query.redirect;

        if (secret != "" && clientid != "" && nodeid != "") {
            var credentials = {
                client_id: clientid,
                secret: secret,
                redirect_uri:redirect
            };
            RED.nodes.addCredentials(nodeid, credentials);
            res.send("success");
        } else {
            res.send("fail");
        }
    });

    /*
    set up endpoint for monzo to redirect back to.  
     */
    RED.httpAdmin.get('/monzo-creds', function(req, res) {
        //upon redirecting get the auth token and post to monzo to get the refresh token and the access_token
        var credential_node_id = req.query.state;
        var monzocreds = RED.nodes.getCredentials(credential_node_id);
        
        var opts = {};
        opts.url = "https://api.monzo.com/oauth2/token";
        opts.timeout = 2000;
        opts.method = "POST";
        opts.headers = {};
        opts.maxRedirects = 21;
    
        var protocol = "";
        if (req.connection.encrypted) {
            protocol = "https";
        } else {
            protocol = "http";
        }

        var auth_token = req.query.code;
        var postvars = {
            grant_type: "authorization_code",
            client_id: monzocreds.client_id,
            client_secret: monzocreds.secret,
            redirect_uri: monzocreds.redirect_uri,
            code: auth_token
        }
        opts.form = postvars;
        
        request(opts, function(err, ress, body) {
            if (err) {
                ////console.log(err)
                res.send(err);
            } else {

                /*
                No errors Set tokens and display to the user it was successful and what the next step is.
                 */
                if(body.trim().length > 0){

                    var bodyObject = JSON.parse(body);
                    var additional_text = "";
                    if (bodyObject.refresh_token) {
                        additional_text = "<br>This API client has Confidential set to True, because of this, your access_token will automatically refresh itself.";
                    } else {
                        //console.log('no refresh token');
                        additional_text = "<br>This token will expire and you will need to manually refresh it. This is because your Monzo API client is set to (Not Confidential).";
                    }
                    if (bodyObject.access_token) {
                        var credentials = {
                            client_id: monzocreds.client_id,
                            secret: monzocreds.secret,
                            token: bodyObject.access_token,
                            refreshtoken: bodyObject.refresh_token
                        };
                        RED.nodes.addCredentials(credential_node_id, credentials);
                        res.send("<center><h1>You have successfully authenticated.</h1><h3>Please return to your node-red flow and close this tab/window, you will see that the 'access_token' is now filled in.</h3>" + additional_text + "</center>");
                    } else {
                        //something went wrong, show error.
                        res.send(body);
                    }
                }else{
                    console.log("[monzo] - Ignoring empty body")
                }
            }
        });
    });

    /*
    Setup MonzoNodeIn
     */
    function MonzoNodeIn(config) {
        RED.nodes.createNode(this, config);
        this.requesttype = config.requesttype;
        this.potid = config.potid;
        this.accountid = config.accountid;
        this.monzoConfig = RED.nodes.getNode(config.monzocreds);
        const Monzo = require('monzo-js');
        var node = this;
        
        if (!this.monzoConfig) {
            this.status({
                fill: "red",
                shape: "dot",
                text: "no token"
            });
        } else {
            this.status({
                fill: "green",
                shape: "dot",
                text: "ready"
            });
        }
        
        /*
        setup on node input function so that we can handle api requests.
         */
        node.on('input', function(msg) {
            this.monzoConfig = RED.nodes.getNode(config.monzocreds);
            var monzocredentials = RED.nodes.getCredentials(config.monzocreds);
            console.log("[monzo] - monzo node in - credentials are: " + JSON.stringify(monzocredentials));
            
            if (msg.potid != "" && msg.potid != undefined) {
                this.potid = msg.potid;
            }
            if (msg.accountid != "" && msg.accountid != undefined) {
                this.accountid = msg.accountid;
            }
            if (msg.requesttype != "" && msg.requesttype != undefined) {
                orig_requesttype = msg.requesttype;
                var type = config.requesttype;
                var typesplit = type.split('-');
                this.requesttype = typesplit[0];
            }

            this.status({
                fill: "yellow",
                shape: "dot",
                text: "requesting"
            });

            if (!this.monzoConfig) {
                this.status({
                    fill: "red",
                    shape: "dot",
                    text: "no token"
                });
                node.error("you have not entered a token", msg);
            } else {
               
                /*
                We have credentials and access tokens, allow requests to happen.
                 */
                const monzo = new Monzo(monzocredentials.token);
                /*
                Accounts request
                */
                if (this.requesttype == "accounts") {
                    monzo.accounts.all().then(accounts => {
                        for (const [id, acc] of accounts) {
                            var newMsg = Object.assign({}, msg);
                            newMsg.payload = {
                                "response": acc._account
                            };
                            node.send(newMsg);
                            this.status({
                                fill: "green",
                                shape: "dot",
                                text: "ready"
                            });
                        }
                    }).catch(error => {
                        node.error("your token is not authenticated. -> "+error, msg);
                        this.status({
                            fill: "red",
                            shape: "dot",
                            text: "no auth"
                        });
                    });
                }
                /*
                Balances request
                */
                if (this.requesttype == "balances") {
                    monzo.accounts.all().then(accounts => {
                        for (const [id, acc] of accounts) {
                            var newMsg = Object.assign({}, msg);
                            newMsg.payload = {
                                "account": acc.id,
                                "response": acc._balance._balance
                            };
                            node.send(newMsg);
                            this.status({
                                fill: "green",
                                shape: "dot",
                                text: "ready"
                            });
                        }
                    }).catch(error => {
                        node.error("your token is not authenticated. -> "+error, msg);
                        this.status({
                            fill: "red",
                            shape: "dot",
                            text: "no auth"
                        });
                    });
                }
                /*
                Pots request
                 */
                if (this.requesttype == "pots") {
                    monzo.pots.all(this.accountid).then(pots => {
                        for (const [id, pot] of pots) {   
                            var newMsg = Object.assign({}, msg);
                            newMsg.payload = {
                                "response": {
                                    "pot_id": pot.id,
                                    "pot_name": pot.name,
                                    "pot_balance": pot.balance,
                                    "pot_goal_amount": pot._pot.goal_amount
                                }
                            };
                            node.send(newMsg);
                            this.status({
                                fill: "green",
                                shape: "dot",
                                text: "ready"
                            });
                        }
                    }).catch(error => {
                        node.error("your token is not authenticated. -> "+error, msg);
                        this.status({
                            fill: "red",
                            shape: "dot",
                            text: "no auth"
                        });
                    });
                }
                /*
                Pot request
                 */
                if (this.requesttype == "pot") {
                    monzo.pots.find(this.potid, this.accountid).then(pot => {
                            var newMsg = Object.assign({}, msg);
                            newMsg.payload = {
                                "response": {
                                    "pot_id": pot.id,
                                    "pot_name": pot.name,
                                    "pot_balance": pot.balance,
                                    "pot_goal_amount": pot._pot.goal_amount
                                }
                            };
                            node.send(newMsg);
                            this.status({
                                fill: "green",
                                shape: "dot",
                                text: "ready"
                            });
                    }).catch(error => {
                        node.error("your token is not authenticated. -> "+error, msg);
                        this.status({
                            fill: "red",
                            shape: "dot",
                            text: "no auth"
                        });
                    });
                }
                /*
                Transactions request
                 */
                if (this.requesttype == "transactions") {
                    // Get account
                    monzo.accounts.find(this.accountid).then(account => {                    
                        var d = new Date();
                        d.setDate(d.getDate() - 89);
                        d = d.toISOString();
                        account.transactions.since(d).then(transactions => {

                            var arr = [];
                            for (const [id, transaction] of transactions) {
                                arr.push({
                                    "id": transaction.id,
                                    "account_balance": transaction._transaction.account_balance,
                                    "amount": transaction._transaction.amount,
                                    "created": transaction._transaction.created,
                                    "currency": transaction._transaction.currency,
                                    "description": transaction._transaction.description,
                                    "merchant": transaction._transaction.merchant,
                                    "metadata": transaction._transaction.metadata,
                                    "notes": transaction._transaction.notes,
                                    "is_load": transaction._transaction.is_load,
                                    "settled": transaction._transaction.settled,
                                    "category": transaction._transaction.category,
                                    "amount_is_pending": transaction._transaction.amount_is_pending
                                })
                            }
                            var newMsg = Object.assign({}, msg);
                            newMsg.payload = {
                                "response": arr
                            };
                            node.send(newMsg)
                            this.status({
                                fill: "green",
                                shape: "dot",
                                text: "ready"
                            });
                          });
                      }).catch(error => {
                        node.error("your token is not authenticated. -> "+error, msg);
                        this.status({
                            fill: "red",
                            shape: "dot",
                            text: "no auth"
                        });
                    });
                }
            }
        });
    }
    RED.nodes.registerType("monzo-in", MonzoNodeIn);
}