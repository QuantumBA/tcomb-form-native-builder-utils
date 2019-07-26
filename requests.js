import { createApolloFetch } from 'apollo-fetch'
import stringTemplate from '@foqum/string-template'
import { getPayloadError } from 'getpayload'
import objectToFormData from '@foqum/object-to-formdata'

// Private helpers functions
const removeEmptyKeys = (obj) => {
  if (!obj) return
  Object.entries(obj).forEach(([k, v]) => {
    if (!v && v !== 0 && typeof v !== 'boolean') delete obj[k]
    else if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
      v.forEach(e => removeEmptyKeys(e))
    }
  })
}

const isString = x => typeof x === 'string'

const getFieldName = (key) => {
  if (isString(key)) return key
  return Object.values(key)[0]
}

// Object serialization without quotes around the keys.
// To be used with graphQL
function stringify(input, depth = 0) {
  // array
  if (Array.isArray(input)) {
    const obj = Object.values(input).map(v => `{${stringify(v)}}`)
    return `[${obj}]`
  }

  // native type
  if (typeof input !== 'object') return JSON.stringify(input)

  // object
  depth += 1
  let stringArray = Object.keys(input).map(key => `${key}:${stringify(input[key], depth)}`)
  if (depth > 1 && typeof input === 'object') {
    stringArray = stringArray.map(obj => `{${obj}}`) // add brackets for objects
  }
  return stringArray.join(',')
}

async function processRemoteRequests(uriTemplate, stackedPlaceholders, headers, body = undefined) {
  let response = {}
  const input = stringTemplate(uriTemplate, stackedPlaceholders, /\$\{([0-9a-zA-Z_\.]+)\}/g, '${') // eslint-disable-line
  // Fetch `select` remote entries definition
  if (!body) {
    // TODO use already defined `enum` value as default in case of error?
    response = await fetch(input, { headers }).then(getPayloadError)
  } else {
    const apolloFetch = createApolloFetch({
      uri: uriTemplate,
    })

    response = await apolloFetch({ query: body })
  }
  return response
}

async function processRemoteUpdateGraphQL(uri, body, meta) {
  body = JSON.stringify(body, (key, value) => (value === null ? '' : value))
  const body_json = JSON.parse(body)
  removeEmptyKeys(body_json)

  const body_query = stringify(body_json)
  const apolloFetch = createApolloFetch({ uri })

  apolloFetch.useAfter(({ response }, next) => {
    if (response.parsed.errors) {
      throw response.parsed.errors[0]
    }
    next()
  })
  if (meta.graphql.method) {
    const response_fields = meta.graphql.response_fields ? meta.graphql.response_fields.join(' ') : '_id'
    const mutation = `mutation { response: ${meta.graphql.method}(${body_query}) {${response_fields}} }`

    return apolloFetch({ query: mutation })
  }

  // method not in method (retrocompatibility)
  const mutation = `mutation { ${meta.graphql}(${body_query}) {response message} }`

  return apolloFetch({ query: mutation }).then(resp => resp)

}

async function processRemoteUpdateRest(uri, body, contentType, headers) {

  if (contentType === 'application/json') {
    body = JSON.stringify(body, (key, value) => (value === null ? '' : value))
  } else {
    body = objectToFormData(body)
  }

  return fetch(uri, {
    method: 'POST',
    headers,
    body,
  }).then(getPayloadError).then(resp => resp)

}

async function asyncForEach(array, callback) {
  for (let index = 0; index < array.length; index += 1) {
    await callback(array[index], index, array) // eslint-disable-line
  }
}

async function processListRemoteUpdate(remote, formValues) {

  const responses = []
  const responsesFn = async () => {
    await asyncForEach(remote, async (remoteObject) => {
      const { meta, uri } = remoteObject
      const { headers = {}, contentType = 'multipart/form-data', updateFields } = meta
      let postBody = JSON.parse(JSON.stringify(formValues))
      Object.keys(postBody).forEach((k) => {
        if (Array.isArray(postBody[k])) {
          postBody[k].forEach((v) => {
            delete v.S3file
          })
        }
      })
      Object.values(postBody).forEach((v) => {
        if (typeof v === 'object' && v !== null) {
          delete v.S3file
        }
      })
      // set fields sent to graphql resolver accessing form values and/or previous response
      // if not informed it will select all values from the form
      if (updateFields) {
        postBody = Object.keys(postBody)
          .filter(field => updateFields.includes(field))
          .reduce((obj, field) => {return { ...obj, [field]: postBody[field] } }, {}) // eslint-disable-line

        const previousFields = updateFields.filter(field => getFieldName(field).includes('_prev') && isString(field))
        if (previousFields.length > 0) {
          previousFields.forEach((previusField) => {
            const splitArray = getFieldName(previusField).split('.')
            const nameField = splitArray[splitArray.length - 1]
            const indexResponse = parseInt(getFieldName(previusField).split('[')[1].split(']')[0], 10)
            postBody[nameField] = responses[indexResponse].data.response[nameField]
          })
        }

        // encapsulate fields in objects if necessary
        const objectsUpdateFields = updateFields.filter(key => !isString(key))
        objectsUpdateFields.forEach((objectField) => {
          const fieldName = getFieldName(objectField)
          if (fieldName.startsWith('_prev[')) {
            const realFieldName = fieldName.split('.')[1]
            const indexResponse = parseInt(fieldName.split('[')[1].split(']')[0], 10)
            postBody[Object.keys(objectField)[0]] = Object.assign({}, { [realFieldName]: responses[indexResponse].data.response[realFieldName] })
          } else {
            postBody[Object.keys(objectField)[0]] = Object.assign({}, { [fieldName]: formValues[fieldName] })
          }
        })
      }

      // Graphql API
      if (meta.graphql) {
        responses.push(await processRemoteUpdateGraphQL(uri, postBody, meta))
      } else {
        responses.push(await processRemoteUpdateRest(uri, postBody, contentType, headers, meta))
      }

    })

    return responses
  }
  return Promise.all(await responsesFn())

}

export {
  processRemoteRequests,
  processRemoteUpdateGraphQL,
  processRemoteUpdateRest,
  processListRemoteUpdate,
}
