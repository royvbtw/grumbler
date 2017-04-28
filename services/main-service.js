
'use strict';

var conn = require('../dao/connection');
var userDao = require('../dao/user-dao');
var postDao = require('../dao/post-dao');
var serviceData = require('./service-data');
var mainConfig = require('../config/main.config');

var request = require('request');
let debug = require('debug')('main-service');

const LOG_LEVEL = require('../config/main.config').LOG_LEVEL;
let bunyan = require('bunyan');
let log = bunyan.createLogger({
	name: 'main-service',
	streams: [{
		level: LOG_LEVEL,
		path: 'log/grumbler.log'
	}]
});

var standardRejectMessage = '服務暫時無法使用，請稍後重試。';

const PAGE_SIZE = 10;

exports.getPostSettings = getPostSettings;

// wrapper functions
exports.about = about;
exports.getUserInfo = getUserInfo;
exports.queryPosts = queryPosts;

exports.createAndLoginFbUser = createAndLoginFbUser;
exports.createAndLoginGoogleUser = createAndLoginGoogleUser;
exports.createAppUser = createAppUser;
exports.deleteUser = deleteUser;

exports.updateUserName = updateUserName;
exports.login = login;

exports.createPost = createPost;
exports.getPost = getPost;
exports.updatePost = updatePost;
exports.deletePost = deletePost;
exports.countPosts = countPosts;

function getPostSettings(){
	let data = {};
	data.postCategory = serviceData.postCategory;
	data.expiryTypes = serviceData.expiryTypes;
	return data;
}

async function countPosts({uid, ignoreExpiry = false} = {}){
	log.debug({uid: uid, ignoreExpiry: ignoreExpiry}, 'countPosts() start.');
	try{
		let opt = {};
		
		if(uid){
			opt['user.authId'] = uid;
		}
		
		if(!ignoreExpiry){
			opt.expiry = {$gte: new Date()};
		}
		log.debug({opt: opt}, 'countPost(): print opt');
	
		let count = await postDao.countPosts(opt);
		log.debug('countPosts()=%s', count);
		return count;
	}catch(ex){
		log.error({error: ex.stack}, 'Error in countPage()');
		return -1;
	}
}

/**
 * To create and/or login Facebook user. The argument is a profile object 
 * parsed by passport-facebook module.
 * @param {Object} profile object. Parsed by passport-facebook module.
 * @return {Object} A promise object. Resolve a user object if creation success. 
 */
function createAndLoginFbUser(profile){
	return new Promise( (resolve, reject) => {
		log.debug({profile: profile}, 'createAndLoginFbUser()');
		let authId = 'fb:' + profile.id;
		
		getUser(authId).then( (doc) => {
			if(doc){
				log.debug('The facebook user is exist. Return user doc directly.');
				return resolve(doc);
			}else{
				var preparedUser = {
					authId: authId,
					name: profile['_json'].name,
					password: null,
					email: profile['_json'].email || '0',
					created: new Date(),
					avator: 'nopath'	// Pre-reserved field.
				};
				
				// create fb user to database
				doCreateUser(preparedUser).then( (doc) => {
					return resolve(doc);
				}).catch( ex => {
					log.error({error: ex.stack}, 'Error in createAndLoginFbUser(): create user');
					return reject('error');
				});
			}
		}).catch( ex => {
			log.error({error: ex.stack}, 'Error in createAndLoginFbUser(): get user.');
			return  reject('error');
		});
	});
}

/**
 * To create and/or login Google OAuth user. User info(google id, name and 
 * email will be stored into database.
 * @param {Object} profile
 * @return {Promise}
 */
function createAndLoginGoogleUser(profile){
	return new Promise( (resolve, reject) => {
		log.debug({'profile.id': profile.id}, 'createAndLoginGoogleUser() start');
		let authId = 'google:' + profile.id;
		
		getUser(authId).then( doc => {
			if(doc){
				log.debug('The facebook user is exist. Return user doc directly.');
				return resolve(doc);
			}else{
				let preparedUser = {
					authId: authId,
					name: profile.displayName || profile['_json'].name,
					password: null,
					email: profile['_json'].email || '0',
					created: new Date(),
					avator: 'nopath'	// Pre-reserved field.
				};
				
				// Create google user to database
				doCreateUser(preparedUser).then( (doc) => {
					return resolve(doc);
				}).catch( ex => {
					log.error({error: ex.stack}, 'Error in createAndLoginGoogleUser: create user');
					return reject('error');
				});
			}
		}).catch( (ex) => {
			log.error({error: ex.stack}, 'Error in createAndLoginGoogleUser(): get user');
			return  reject('error');
		});
	});
}

/**
 * Wrapper function
 * @param {object} user
 * @return {Object} a Promise object
 */
function createAppUser(user){
	return new Promise(function(resolve, reject){
		let preparedUser = {
			authId: 'app:' + user.account,
			name: user.name,
			password: user.password,
			email: user.email || '0',
			created: new Date(),
			avator: 'nopath'	// Pre-reserved field.
		};
		if(!validateUserFields(preparedUser)){
			return reject('您的欄位含有不允許的字元');
		}
		doCreateUser(preparedUser).then( doc => {
			return resolve(doc);
		}).catch(ex => {
			return reject(ex);
		});
	});
}

/**
 * Format date to yyyy/mm/dd-hh:mm
 * @param {Date} d A date object which will be format
 * @return {string} formattedDate formated date
 */
function formatDate(d){
	var formattedDate = d.getFullYear() + '/' + (d.getMonth() + 1) + '/'
			+ d.getDate() + ', ' + d.getHours() + ':' + d.getMinutes();
	return formattedDate;
}

/**
 * Validate user data(account, password, email) by regex patterns.
 * @param {object} user
 * @return {boolean} true if user data is valid
 */
function validateUserFields(user, opt){
	var check = {};
	if(opt === undefined){
		check = {
			authId: true,
			pwd: true,
			email: true
		};
	}else{
		check = {
			authId: opt.authId || false,
			email: opt.email || false,
			pwd: opt.password || false
		};
	}
	log.debug({user: user, check: check}, 'validateUserFields() start');
	var idPattern = /^(app|google|fb):[a-zA-Z0-9_-]{6,}[^_-]$/;
	var pwdPattern = /^[a-zA-Z0-9]{8,30}$/;
	// this email pattern is according to the w3c design
	var emailPattern = 
			/^[a-zA-Z0-9.!#$%&’*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*$/;
	
	var idResult = idPattern.test(user.authId);
	var pwdResult = pwdPattern.test(user.password);
	var emailResult = emailPattern.test(user.email);
	log.debug('User data validate results: id=%s, pwd=%s, email=', 
			idResult, pwdResult, emailResult);

	if(check.authId && !idResult) return false;
	if(check.pwd && !pwdResult) return false;
	if(check.email && !emailResult) return false;
	return true;
}


/**
 * 
 * @return {result} object
 */
async function about(){
	try{
		let result = {};
		result.userCount = await userDao.countUsers();
		result.postCount = await countPosts();
		result.allPostCount = await countPosts({ignoreExpiry: true});
		log.debug({result: result}, 'about() finished.');
		return result;
	}catch(ex){
		log.error({error: ex.stack}, 'Error in about().');
	}
}

/**
 * 
 * @param {object} post
 * @return {Promise}
 */
function createPost(post){
	return new Promise( (resolve, reject) => {
		log.debug({post: post}, 'createPost() started.');
		
		// verify the google re-captcha
		var recaptchaOptions = {
			url: 'https://www.google.com/recaptcha/api/siteverify',
			form: {
				secret: mainConfig.recaptchaSecret,
				response: post.verify
			}
		};
		
		log.trace({recaptchaOpt: recaptchaOptions}, 'createPost(): Print recaptchaOptions');
		
		request.post(recaptchaOptions, function (error, response, body) {
			if(error){
				log.error({error: error, errorStack: error.stack}, 'Error in recaptcha verification.');
				return reject('Google re-captcha error.');
			}
			var verifyResult = JSON.parse(body);
			if(response.statusCode === 200 && verifyResult.success === true){
				var preparedPost = {
					title: post.title,
					content: post.content,
					category: post.category,
					user:{
						authId: post.uid,
						name: post.uname
					},
					created: new Date(),	//date of created. new Date.toString()
					expiry: new Date(new Date().getTime() + serviceData.expiryTypes[post.expiry].offset),
					anonymous: post.ghost
				};
				log.trace({preparedPost: preparedPost}, 'createPost(): Print preparedPost');
				postDao.createPost(preparedPost).then( ()=> {
					return resolve('ok');
				}).catch( ex => {
					log.error({error: ex.stack}, 'Error in createPost()');
					return reject('error');
				});
			}else{
				log.info('Google re-captcha check is failed.');		//#roy-todo: check the google doc
				return reject('Google re-captcha is invalid...');
			}
		});
	});
}


/**
 * #todo-roy: need to review.
 * @param {Object} user object
 * @return {Promise}
 */
function doCreateUser(user){
	return new Promise(function(resolve, reject){
		log.debug({user: user}, 'doCreateUser() started.');
		
		// #roy-todo: 在呼叫doCreateUser()之前其實就已經確認過user是否存在.
		// 那麼在doCreateUser裡面是否要再確認一次?
		// 確認pros: 安全
		// cons: 重複.
		
		//那如果把確認user是否存在的工作交給doCreateUser做，是否ok?
		//應從work flow去區分各個function之作用為何!
		userDao.findUserById(user.authId).then(doc => {
			if(doc){ return reject('本帳號已存在，請重新設定'); }	//#roy-todo: reject should not as flow control
			// the user is not exist, continue to create the user
			userDao.createUser(user).then( (doc) => {
				return resolve(doc);
			}).catch( ex => {
				// db error, but don't directly send back to client
				log.error({error: ex.stack}, 'Error in doCreateUser()');
				return reject('error');
			});

		}).catch( ex => {
			log.error({error: ex.stack}, 'Error in doCreateUser()');
			return reject('User register failed');
		});
	});
};

//#todo: 需要修改args為object型態
function deletePost(postId, currentId){
	// check if currentId === post.user.authId
	return new Promise( (resolve, reject) => {
		postDao.getPost(postId).then( (doc) => {
			if(doc.user.authId !== currentId){
				return reject('ID不相符');
			}else{
				postDao.deletePost(postId).then( () => {
					return resolve('ok');
				}).catch( (ex) => {
					return reject('failed');
				});
			}
		}).catch( (ex) => {});
	});
}

/**
 * 
 * @param {object} user
 * @return {Promise}
 */
async function deleteUser(uid){
	log.info('deleteUser(%s) started', uid);
	try{
		await userDao.deleteUserById(uid);
		log.info('deleteUser() finished.');
	}catch(ex){
		log.error({error: ex}, 'Error in deleteUser()');
	}
}

//#todo-roy
function getPost(postId){}

async function doGetPosts(conditions){
	log.debug({conditions: conditions}, 'doGetPosts() started.');
	let posts = await postDao.listPosts(conditions);
	log.trace('doGetPosts(): posts.length=%s', posts.length);
	var d = new Date();
	for(var i in posts){
		//console.log('post[%s]=', i, posts[i]);
		posts[i].postId = posts[i]._id;	// remap _id to postId
		delete posts[i]._id;
		
		if(posts[i].anonymous){
			posts[i].user.authId = '0';
			posts[i].user.name = '這是個忍者!';
		}
		delete posts[i].anonymous;
		
		if(posts[i].category === undefined){
			posts[i].category = '無';
		}
		posts[i].created = formatDate(posts[i].created);
		if(posts[i].expiry){
			if(posts[i].expiry < d){
				posts[i].isExpired = true;
			}
			posts[i].expiry = formatDate(posts[i].expiry);
		}
		//console.log('[service] Modified doc[%s]=', i, docs[i]);
	}
	return posts;
}

async function queryPosts({uid, pageNo = 1, pageSize} = {}){
	pageNo = Number(pageNo);
	if(isNaN(pageNo)){
		pageNo = 1;
	}
	pageSize = (pageSize >= PAGE_SIZE)? pageSize: PAGE_SIZE;
	
	let conditions = {
		query: {
			//'user.authId': 'fb:1645788332105202',
			//expiry: {$gt: new Date()}
		},
		limit: pageSize
	};
	if(uid){
		conditions.query['user.authId'] = uid;
	}else{
		conditions.projection = {expiry: 0};
		conditions.query.expiry = {$gt: new Date()};
	}
	
	try{
		let postCount = await countPosts({
			uid: uid, 
			ignoreExpiry: (uid)? true: false
		});
		let pageCount = Math.ceil(postCount / pageSize);
		
		pageNo = (pageNo > pageCount)? pageCount: pageNo;
		conditions.skip = (pageNo - 1) * pageSize;
		
		let result = {};
		result.posts = await doGetPosts(conditions);
		//#roy-todo: what to do if no any result?
		result.currentPage = pageNo;
		result.pageCount = pageCount;
		result.postCount = postCount;

		// deal with pagination.
		result.page = {};
		result.page.first = (pageNo === 1)? null: 1;
		result.page.next = (pageNo < pageCount)? (pageNo + 1): null;
		result.page.prev = (pageNo > 1)? (pageNo - 1): null;
		result.page.last = (pageNo === pageCount)? null: pageCount;
		return result;
	}catch(ex){
		log.error({error: ex.stack}, 'Error in queryPosts()');
		return false;
	}
}

/**
 * 
 * @param {type} uid
 * @return {user|result} null if no such user
 */
async function getUser(uid){
	log.debug('getUser(%s) started.', uid);
	if(uid === '0'){
		let result = {};
		result.name = '這是個忍者';
		return result;
	}
	
	if(!validateUserFields({id: uid}, {id: true})){
		log.error('不該有這個id:', uid);
		let result = {};
		result.name = '不該有這id';	//#roy-todo: need to test
		return result;
	}
	
	try{
		let user = await userDao.findUserById(uid);
		log.debug({user: user}, 'getUser(%s) finished.', uid);
		return user;
	}catch(ex){
		log.error({error: ex}, 'Error in getUser().');
	}
}

/**
 * wrapper function.
 * @param {string} uid User id
 * @return {object} result User details, or false if the user doesn't exist.
 */
async function getUserInfo(uid){
	try{
		log.debug('getUserInfo(%s) start', uid);
		let result = {};
		result.user = await getUser(uid);
		log.debug({'result.user': result.user}, 'getUserInfo(): Print result.user');
		if(!result.user){
			log.debug('getUserInfo(%s): No such user.', uid);
			return false;
		}
		result.postCount = await countPosts({uid: uid});
		result.allPostCount = await countPosts({uid: uid, ignoreExpiry: true});
		return result;
	}catch(ex){
		log.error({error: ex}, 'Error in getUserInfo()');
	}
}

/**
 * 
 * @param {user} user object
 * @return {object} user object
 */
async function login(user){
	try{
		// vaildate the login account first.
		if(!validateUserFields(user, {account: true})){
			log.warn('login(): 輸入帳號有問題,有人不是透過browser發出post');
			return {failed: '帳號或密碼格式錯誤'};
		}
		
		let result = await userDao.findUserById('app:' + user.account);
		if(result === null){
			log.debug({'user.account': user.account}, 'login(): No such account exist.');
			return {failed: '帳號(或密碼)錯誤'};
		}
			
		//#roy-todo: Should use hash to store/compare password here
		if(result.password === user.password){
			log.debug('login(): %s login success.', user.account);
			return {id: result.authId, name: result.name};
		}else{
			log.debug('login(): Password error.');
			return {failed: '帳號或密碼錯誤'};	// security:不要單單使用[密碼錯誤]
		}
	}catch(ex){
		log.error({error: ex.stack}, 'Error in login()');
		return {failed: 'ERROR'};	// security:不要單單使用[帳號錯誤]
	}
}

//#todo-roy
function updatePost(post){}

/**
 * Update user collection and a user sub-doc in post collection.
 * @param {object} user
 * @return {Promise}
 */
async function updateUserName(user){
	try{
		log.debug({user: user}, 'updateUserName() started');
		if(!validateUserFields(user, {name: true})){
			log.debug('updateUserName(): 資料驗證失敗');
			return {ok: false, msg: '更新資料失敗，請確認資料'};
		}
		await userDao.updateUser(user);
		await postDao.updatePost({'user.authId': user.authId}, {'user.name': user.name});
		return {ok: true, msg: 'Update success'};
	}catch(ex){
		log.error({error: ex.stack, user: user}, 'Error in updateUserName()');
		return {ok: false, msg: '更新資料失敗，請重新送出'};
	};
}