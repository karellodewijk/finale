'use strict';

var util = require('util'),
    Base = require('./base'),
    _ = require('lodash'),
    errors = require('../Errors'),
    getKeys = require('../util').keys;

var List = function(args) {
  List.super_.call(this, args);
};

util.inherits(List, Base);

List.prototype.action = 'list';
List.prototype.method = 'get';
List.prototype.plurality = 'plural';

List.prototype._safeishParse = function(value, type, sequelize) {

  if (sequelize) {
    if (type instanceof sequelize.STRING || type instanceof sequelize.CHAR || type instanceof sequelize.TEXT) {
      if (!isNaN(value)) {
        return value;
      }
    } else if (type instanceof sequelize.INTEGER || type instanceof sequelize.BIGINT) {

    }
  }

  try {
    return JSON.parse(value);
  } catch(err) {
    return value;
  }
};

List.prototype.fetch = function(req, res, context) {
  var self = this,
      model = this.model,
      options = context.options || {},
      criteria = context.criteria || {},
      // clone the resource's default includes so we can modify them only for this request
      include = _.cloneDeepWith(this.include, value => {
        // ...but don't clone Sequelize models
        if (value.prototype && value.prototype.toString().includes('SequelizeInstance:'))
          return value;
      }),
      includeAttributes = this.includeAttributes,
      Sequelize = this.resource.sequelize,
      defaultCount = 10000,
      count = parseFloat(context.count || req.query.count || defaultCount),
      offset = +context.offset || +req.query.offset || 0;
  
  var stringOperators = [
    Sequelize.Op.like, Sequelize.Op.iLike, Sequelize.Op.notLike, Sequelize.Op.notILike,
  ];

  // only look up attributes we care about
  options.attributes = options.attributes || this.resource.attributes;

  // account for offset and count
  offset += context.page * count || req.query.page * count || 0;
  if (count < 0) count = defaultCount;

  options.offset = offset;
  options.limit = count;
  if (!this.resource.pagination)
    delete options.limit;

  if (context.include && context.include.length) {
    include = include.concat(context.include);
  }
  if (include.length) {
    options.include = include;
  }


  //if shallow flag exists and is true, only "include" children that are in the
  //optional "children" query param, and that were in our whitelist of potential includes
    if(context.shallow){
      let child_raw = req.query.children;
      if(!child_raw) {
      //if shallow, and no children requested, include none.
        delete options.include;
      } else {
        let children = child_raw.split("|");
        let cleaned_include = [];
        for(let i=0;i<options.include.length;i++) {
          let include = options.include[i];
          if(include.as && children.indexOf(include.as) !== -1)
          {
            cleaned_include.push(include);
          }
          else{
            //not a match, don't include.
          }
        }
        options.include = cleaned_include;
      }
    }

  var positiveStringOperators = [
    Sequelize.Op.like,
    Sequelize.Op.iLike,
  ];

  function isStringOperator(operator) {
    return stringOperators.indexOf(operator) !== -1;
  }

  function isPositiveStringOperator(operator) {
    return positiveStringOperators.indexOf(operator) !== -1;
  }

  function toArray(value) {
    return Array.isArray(value) ? value : [value];
  }

  function isSearchableAttribute(attr, operator) {
    if (!model.rawAttributes[attr]) return false;

    if (!isStringOperator(operator)) return true;

    var attrType = model.rawAttributes[attr].type;
    return (
      attrType instanceof Sequelize.STRING ||
      attrType instanceof Sequelize.TEXT
    );
  }

  function makeAttributeQuery(attr, operator, value) {
    var query = {};
    query[operator] = value;

    var item = {};
    item[attr] = query;

    return item;
  }

  function hasAdvancedSearchSyntax(str) {
    return (
      str.indexOf(',AND,') !== -1 ||
      str.indexOf(',OR,') !== -1 ||
      str.indexOf('%') !== -1
    );
  }

  function normaliseAdvancedValue(value, operator) {
    value = String(value).trim();

    // Keep explicit wildcards working. If none are provided, treat advanced
    // string searches as partial matches for backwards-compatible behaviour.
    if (isPositiveStringOperator(operator) && value.indexOf('%') === -1) {
      value = '%' + value + '%';
    }

    return value;
  }

  function buildAdvancedSearchCriteria(raw, searchAttributes, searchOperator, searchOverride) {
    var andCriteria = [];

    raw.split(',AND,').forEach(function(andPart) {
      var orCriteria = [];

      andPart.split(',OR,').forEach(function(orPart) {
        var value = String(orPart).trim();
        if (!value) return;

        var operator = searchOperator;

        if (searchOverride === 'STARTS_WITH') {
          operator = Sequelize.Op.like;
          value = value.replace(/%/g, '') + '%';
        } else {
          value = normaliseAdvancedValue(value, operator);
        }

        searchAttributes.forEach(function(attr) {
          orCriteria.push(makeAttributeQuery(attr, operator, value));
        });
      });

      if (orCriteria.length) {
        andCriteria.push({ [Sequelize.Op.or]: orCriteria });
      }
    });

    if (!andCriteria.length) return null;
    if (andCriteria.length === 1) return andCriteria[0];

    return { [Sequelize.Op.and]: andCriteria };
  }

  function buildPlainSearchCriteria(raw, searchAttributes, searchOperator, searchOverride) {
    var term = String(raw).trim();
    if (!term) return null;

    var searches = [];

    searchAttributes.forEach(function(attr) {
      if (searchOverride === 'STARTS_WITH') {
        searches.push(makeAttributeQuery(attr, Sequelize.Op.like, term + '%'));
        return;
      }

      if (!isPositiveStringOperator(searchOperator)) {
        searches.push(makeAttributeQuery(attr, searchOperator, term));
        return;
      }

      // 1) exact match
      searches.push(makeAttributeQuery(attr, searchOperator, term));

      // 2) prefix match
      searches.push(makeAttributeQuery(attr, searchOperator, term + '%'));

      // 3) full phrase partial match
      searches.push(makeAttributeQuery(attr, searchOperator, '%' + term + '%'));

      // 4) any keyword partial match
      term.split(/\s+/)
        .filter(function(word) { return word; })
        .forEach(function(word) {
          searches.push(makeAttributeQuery(attr, searchOperator, '%' + word + '%'));
        });
    });

    if (!searches.length) return null;

    return { [Sequelize.Op.or]: searches };
  }

  function escapeSqlString(value) {
    value = String(value);

    if (Sequelize.escape) {
      return Sequelize.escape(value);
    }

    return "'" + value.replace(/'/g, "''") + "'";
  }

  function quoteColumn(attr) {
    var column = model.rawAttributes[attr].field || attr;
    return '"' + String(column).replace(/"/g, '""') + '"';
  }

  function buildRelevanceOrder(raw, searchAttributes) {
    var term = String(raw).trim().toLowerCase();
    if (!term || !searchAttributes.length) return null;

    var words = term.split(/\s+/).filter(function(word) {
      return word;
    });

    function lowerColumn(attr) {
      return 'LOWER(' + quoteColumn(attr) + ')';
    }

    function anyAttributeEquals(value) {
      return searchAttributes.map(function(attr) {
        return lowerColumn(attr) + ' = ' + escapeSqlString(value);
      }).join(' OR ');
    }

    function anyAttributeLike(value) {
      return searchAttributes.map(function(attr) {
        return lowerColumn(attr) + ' LIKE ' + escapeSqlString(value);
      }).join(' OR ');
    }

    var keywordChecks = [];

    words.forEach(function(word) {
      searchAttributes.forEach(function(attr) {
        keywordChecks.push(
          lowerColumn(attr) + ' LIKE ' + escapeSqlString('%' + word + '%')
        );
      });
    });

    return Sequelize.literal(
      'CASE ' +
        'WHEN ' + anyAttributeEquals(term) + ' THEN 0 ' +
        'WHEN ' + anyAttributeLike(term + '%') + ' THEN 1 ' +
        'WHEN ' + anyAttributeLike('%' + term + '%') + ' THEN 2 ' +
        'WHEN ' + keywordChecks.join(' OR ') + ' THEN 3 ' +
        'ELSE 4 ' +
      'END'
    );
  }

  var relevanceOrders = [];

  var searchParams = this.resource.search.length ? this.resource.search : [this.resource.search];
  searchParams.forEach(function(searchData) {
    var searchParam = searchData.param;

    if (!req.query[searchParam]) return;

    var searchOperator = searchData.operator || Sequelize.Op.iLike;
    var searchOverride = searchData.override || undefined;
    var searchAttributes = searchData.attributes || getKeys(model.rawAttributes);

    searchAttributes = searchAttributes.filter(function(attr) {
      return isSearchableAttribute(attr, searchOperator);
    });

    if (!searchAttributes.length) return;

    var queryParts = [];

    toArray(req.query[searchParam]).forEach(function(rawSearchString) {
      if (rawSearchString === undefined || rawSearchString === null) return;

      rawSearchString = String(rawSearchString).trim();
      if (!rawSearchString) return;

      var query;

      if (hasAdvancedSearchSyntax(rawSearchString)) {
        query = buildAdvancedSearchCriteria(
          rawSearchString,
          searchAttributes,
          searchOperator,
          searchOverride
        );
      } else {
        query = buildPlainSearchCriteria(
          rawSearchString,
          searchAttributes,
          searchOperator,
          searchOverride
        );

        if (
          searchOverride !== 'STARTS_WITH' &&
          isPositiveStringOperator(searchOperator)
        ) {
          var relevanceOrder = buildRelevanceOrder(rawSearchString, searchAttributes);
          if (relevanceOrder) {
            relevanceOrders.push([relevanceOrder, 'ASC']);
          }
        }
      }

      if (query) {
        queryParts.push(query);
      }
    });

    if (queryParts.length) {
      criteria = Sequelize.and(criteria, { [Sequelize.Op.and]: queryParts });
    }
  });

  var sortParam = this.resource.sort.param;
  if (_.has(req.query, sortParam) || _.has(this.resource.sort, 'default')) {
    var order = [];
    var columnNames = [];
    var sortQuery = req.query[sortParam] || this.resource.sort.default || '';
    var sortColumns = sortQuery.split(',');
    sortColumns.forEach(function(sortColumn) {
      if (sortColumn.indexOf('-') === 0) {
        var actualName = sortColumn.substring(1);
        order.push([actualName, 'DESC NULLS LAST']);
        columnNames.push(actualName);
      } else {
        columnNames.push(sortColumn);
        order.push([sortColumn, 'ASC']);
      }
    });
    var allowedColumns = this.resource.sort.attributes || getKeys(model.rawAttributes);
    var disallowedColumns = _.difference(columnNames, allowedColumns);
    if (disallowedColumns.length) {
      throw new errors.BadRequestError('Sorting not allowed on given attributes', disallowedColumns);
    }

    if (order.length)
      options.order = order;
  }

  if (relevanceOrders.length) {
    options.order = relevanceOrders.concat(options.order || []);
  }

  // all other query parameters are passed to search
  /*
  var extraSearchCriteria = _.reduce(req.query, function(result, value, key) {
    if (_.has(model.rawAttributes, key)) result[key] = self._safeishParse(value, model.rawAttributes[key].type, Sequelize);
    return result;
  }, {});

  if (getKeys(extraSearchCriteria).length)
    criteria = _.assign(criteria, extraSearchCriteria);
  */

  let extraCriteria2 = []
  for (let key in req.query) {
    let query = key + "=" + req.query[key]; //back to it's original form
    let orCriteria = [];
    for (let orPart of query.split(',OR,')) {
      let andParts = orPart.split(',AND,');
      if (andParts.length > 1) {
          let andCriteria = [];
          for (let andPart of andParts) {
            let [key, value] = andPart.split('=');
            if (value === 'null') value = null;
            if (value) value = value.split(',')
            if (value && value.length === 1) value = value[0];
            if (model.rawAttributes[key])
              andCriteria.push({[key]: value});
          }
          if (andCriteria.length)
            orCriteria.push({[Sequelize.Op.and]: andCriteria});
      } else if (andParts.length === 1) {
          let [key, value] = andParts[0].split('=');
          if (value === 'null') value = null;
          if (value) value = value.split(',')
          if (value && value.length === 1) value = value[0];
          if (model.rawAttributes[key])
            orCriteria.push({[key]: value});
      }
    }
    if (orCriteria.length)
      extraCriteria2.push({[Sequelize.Op.or]: orCriteria});
  }

  extraCriteria2.push(criteria);
  criteria = extraCriteria2;


  // look for search parameters that reference properties on included models
  getKeys(req.query).forEach(key => {
    const path = key.split(".");
    let includes = options.include;
    let currentModel = model;
    while (path.length > 1) {
      const alias = path.shift();
      const prop = path[0];
      let include = includes.find(i => i === alias || i.as === alias); // jshint ignore:line
      if (typeof include === "string") {
        // replace simple include definition with model-as syntax
        const association = currentModel.associations[alias];
        include = {
          model: association.target,
          as: association.options.as
        };
        includes.splice(includes.indexOf(alias), 1, include);
      }
      if (
        !include ||
        (path.length > 1 && !include.include) ||
        (path.length === 1 && !include.model && !_.has(include.model.rawAttributes, prop))
      ) return;
      currentModel = include.model;
      includes = include.include;
      if (path.length === 1) {
        include.where = { [prop]: req.query[key] };
      }
    }
  });

  // do the actual lookup
  if (getKeys(criteria).length)
    options.where = criteria;

  if (req.query.scope) {
    let scopes = req.query.scope.split(',');
    for (let scope of scopes) {
      options.where = Sequelize.and(model.options.scopes[scope].where, options.where);
    }
  }

  //bug fix: Previously, counts with includes are higher than actual number of instances returned.
  //Adding distinct true as an option is the recommended fix from sequelize: https://github.com/sequelize/sequelize/issues/4042
  if(options.include && options.include.length > 0){
    options.distinct = true;
  }

  return model
    .findAndCountAll(options)
    .then(function(result) {
      context.instance = result.rows;
      var start = offset;
      var end = start + result.rows.length - 1;
      end = end === -1 ? 0 : end;

      if (self.resource.associationOptions.removeForeignKeys) {
        _.each(context.instance, function(instance) {
          _.each(includeAttributes, function(attr) {
            delete instance[attr];
            delete instance.dataValues[attr];
          });
        });
      }

      if (!!self.resource.pagination)
        res.header('Content-Range', 'items ' + [[start, end].join('-'), result.count].join('/'));

      return context.continue;
    });
};

module.exports = List;
