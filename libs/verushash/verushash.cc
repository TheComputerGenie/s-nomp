#include <node_api.h>
#include <stdint.h>
#include <vector>

#include "crypto/verus_hash.h"
#include "crypto/blake2.h"

// Verushash Algorithm
CVerusHash *vh;
CVerusHashV2 *vh2;
CVerusHashV2 *vh2b1;
CVerusHashV2 *vh2b2;

bool initialized = false;

void initialize()
{
  if (!initialized)
  {
    CVerusHash::init();
    CVerusHashV2::init();
  }

  vh = new CVerusHash();
  vh2 = new CVerusHashV2(SOLUTION_VERUSHHASH_V2);
  vh2b1 = new CVerusHashV2(SOLUTION_VERUSHHASH_V2_1);
  vh2b2 = new CVerusHashV2(SOLUTION_VERUSHHASH_V2_2);

  initialized = true;
}

napi_value verusInit(napi_env env, napi_callback_info info)
{
  initialize();
  return nullptr;
}

napi_value hash(napi_env env, napi_callback_info info)
{
  napi_status status;
  size_t argc = 1;
  napi_value args[1];
  status = napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (status != napi_ok || argc < 1) {
    napi_throw_error(env, nullptr, "You must provide one argument.");
    return nullptr;
  }

  // Process/Define Passed Parameters
  napi_typedarray_type type;
  size_t length;
  void *input;
  size_t input_len;
  status = napi_get_typedarray_info(env, args[0], &type, &length, &input, nullptr, nullptr);
  if (status != napi_ok || type != napi_uint8_array) {
    napi_throw_error(env, nullptr, "Argument must be a Uint8Array.");
    return nullptr;
  }
  input_len = length;

  char output[32];

  if (initialized == false)
  {
    initialize();
  }

  verus_hash(output, (char *)input, input_len);
  napi_value result;
  status = napi_create_buffer_copy(env, 32, output, nullptr, &result);
  if (status != napi_ok) {
    napi_throw_error(env, nullptr, "Failed to create buffer.");
    return nullptr;
  }
  return result;
}

napi_value hash2(napi_env env, napi_callback_info info)
{
  napi_status status;
  size_t argc = 1;
  napi_value args[1];
  status = napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (status != napi_ok || argc < 1) {
    napi_throw_error(env, nullptr, "You must provide one argument.");
    return nullptr;
  }

  // Process/Define Passed Parameters
  napi_typedarray_type type;
  size_t length;
  void *input;
  size_t input_len;
  status = napi_get_typedarray_info(env, args[0], &type, &length, &input, nullptr, nullptr);
  if (status != napi_ok || type != napi_uint8_array) {
    napi_throw_error(env, nullptr, "Argument must be a Uint8Array.");
    return nullptr;
  }
  input_len = length;

  char output[32];

  if (initialized == false)
  {
    initialize();
  }

  vh2->Reset();
  vh2->Write((const unsigned char *)input, input_len);
  vh2->Finalize((unsigned char *)output);
  napi_value result;
  status = napi_create_buffer_copy(env, 32, output, nullptr, &result);
  if (status != napi_ok) {
    napi_throw_error(env, nullptr, "Failed to create buffer.");
    return nullptr;
  }
  return result;
}

napi_value hash2b(napi_env env, napi_callback_info info)
{
  napi_status status;
  size_t argc = 1;
  napi_value args[1];
  status = napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (status != napi_ok || argc < 1) {
    napi_throw_error(env, nullptr, "You must provide one argument.");
    return nullptr;
  }

  // Process/Define Passed Parameters
  napi_typedarray_type type;
  size_t length;
  void *input;
  size_t input_len;
  status = napi_get_typedarray_info(env, args[0], &type, &length, &input, nullptr, nullptr);
  if (status != napi_ok || type != napi_uint8_array) {
    napi_throw_error(env, nullptr, "Argument must be a Uint8Array.");
    return nullptr;
  }
  input_len = length;

  char output[32];

  if (initialized == false)
  {
    initialize();
  }

  vh2->Reset();
  vh2->Write((const unsigned char *)input, input_len);
  vh2->Finalize2b((unsigned char *)output);
  napi_value result;
  status = napi_create_buffer_copy(env, 32, output, nullptr, &result);
  if (status != napi_ok) {
    napi_throw_error(env, nullptr, "Failed to create buffer.");
    return nullptr;
  }
  return result;
}

napi_value hash2b1(napi_env env, napi_callback_info info)
{
  napi_status status;
  size_t argc = 1;
  napi_value args[1];
  status = napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (status != napi_ok || argc < 1) {
    napi_throw_error(env, nullptr, "You must provide one argument.");
    return nullptr;
  }

  // Process/Define Passed Parameters
  napi_typedarray_type type;
  size_t length;
  void *input;
  size_t input_len;
  status = napi_get_typedarray_info(env, args[0], &type, &length, &input, nullptr, nullptr);
  if (status != napi_ok || type != napi_uint8_array) {
    napi_throw_error(env, nullptr, "Argument must be a Uint8Array.");
    return nullptr;
  }
  input_len = length;

  char output[32];

  if (initialized == false)
  {
    initialize();
  }

  vh2b1->Reset();
  vh2b1->Write((const unsigned char *)input, input_len);
  vh2b1->Finalize2b((unsigned char *)output);
  napi_value result;
  status = napi_create_buffer_copy(env, 32, output, nullptr, &result);
  if (status != napi_ok) {
    napi_throw_error(env, nullptr, "Failed to create buffer.");
    return nullptr;
  }
  return result;
}

const unsigned char BLAKE2Bpersonal[BLAKE2B_PERSONALBYTES] = {'V', 'e', 'r', 'u', 's', 'D', 'e', 'f', 'a', 'u', 'l', 't', 'H', 'a', 's', 'h'};
uint256 blake2b_hash(unsigned char *data, unsigned long long length)
{
  const unsigned char *personal = BLAKE2Bpersonal;
  blake2b_state state;
  blake2b_param P[1];
  uint256 result;
  P->digest_length = 32;
  P->key_length = 0;
  P->fanout = 1;
  P->depth = 1;
  P->leaf_length = 0;
  P->node_offset = 0;
  P->xof_length = 0;
  P->node_depth = 0;
  P->inner_length = 0;
  memset(P->reserved, 0, sizeof(P->reserved));
  memset(P->salt, 0, sizeof(P->salt));
  memcpy(P->personal, personal, sizeof(P->personal));
  if (blake2b_init_param(&state, P) == 0)
  {
    blake2b_update(&state, data, length);
    if (blake2b_final(&state, reinterpret_cast<unsigned char *>(&result), 32) == 0)
    {
      return result;
    }
  }
  result.SetNull();
  return result;
}

napi_value hash2b2(napi_env env, napi_callback_info info)
{
  napi_status status;
  size_t argc = 1;
  napi_value args[1];
  status = napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (status != napi_ok || argc < 1) {
    napi_throw_error(env, nullptr, "You must provide one argument.");
    return nullptr;
  }

  // Process/Define Passed Parameters
  napi_typedarray_type type;
  size_t length;
  void *input;
  size_t input_len;
  status = napi_get_typedarray_info(env, args[0], &type, &length, &input, nullptr, nullptr);
  if (status != napi_ok || type != napi_uint8_array) {
    napi_throw_error(env, nullptr, "Argument must be a Uint8Array.");
    return nullptr;
  }
  input_len = length;

  char output[32];

  if (initialized == false)
  {
    initialize();
  }

  // detect pbaas, validate and clear non-canonical data if needed
  char *solution = (char *)input + 140 + 3;
  unsigned int sol_ver = ((solution[0]) + (solution[1] << 8) + (solution[2] << 16) + (solution[3] << 24));
  if (sol_ver > 6)
  {
    // const uint8_t descrBits = solution[4];
    const uint8_t numPBaaSHeaders = solution[5];
    // const uint16_t extraSpace = solution[6] | ((uint16_t)(solution[7]) << 8);
    const uint32_t soln_header_size = 4 + 1 + 1 + 2 + 32 + 32; // version, descr, numPBaas, extraSpace, hashPrevMMRroot, hashBlockMMRroot
    const uint32_t soln_pbaas_cid_size = 20;                   // hash160
    const uint32_t soln_pbaas_prehash_sz = 32;                 // pre header hash blake2b
    // if pbaas headers present
    if (numPBaaSHeaders > 0)
    {
      unsigned char preHeader[32 + 32 + 32 + 32 + 4 + 32 + 32] = {
          0,
      };

      // copy non-canonical items from block header
      memcpy(&preHeader[0], (char *)input + 4, 32);                         // hashPrevBlock
      memcpy(&preHeader[32], (char *)input + 4 + 32, 32);                   // hashMerkleRoot
      memcpy(&preHeader[64], (char *)input + 4 + 32 + 32, 32);              // hashFinalSaplingRoot
      memcpy(&preHeader[96], (char *)input + 4 + 32 + 32 + 32 + 4 + 4, 32); // nNonce (if nonce changes must update preHeaderHash in solution)
      memcpy(&preHeader[128], (char *)input + 4 + 32 + 32 + 32 + 4, 4);     // nbits
      memcpy(&preHeader[132], solution + 8, 32 + 32);              // hashPrevMMRRoot, hashPrevMMRRoot

      // detect if merged mining is present and clear non-canonical data (if needed)
      int matched_zeros = 0;
      for (size_t i = 0; i < sizeof(preHeader); i++)
      {
        if (preHeader[i] == 0)
        {
          matched_zeros++;
        }
      }

      // if the data has already been cleared of non-canonical data, just continue along
      if (matched_zeros != sizeof(preHeader))
      {
        // detect merged mining by looking for preHeaderHash (blake2b) in first pbaas chain definition
        int matched_hashes = 0;
        uint256 preHeaderHash = blake2b_hash(&preHeader[0], sizeof(preHeader));
        if (!preHeaderHash.IsNull())
        {
          if (memcmp((unsigned char *)&preHeaderHash,
                     &solution[soln_header_size + soln_pbaas_cid_size],
                     soln_pbaas_prehash_sz) == 0)
          {
            matched_hashes++;
          }
        }
        // clear non-canonical data for pbaas merge mining
        if (matched_hashes > 0)
        {
          memset((char *)input + 4, 0, 32 + 32 + 32);              // hashPrevBlock, hashMerkleRoot, hashFinalSaplingRoot
          memset((char *)input + 4 + 32 + 32 + 32 + 4, 0, 4);      // nBits
          memset((char *)input + 4 + 32 + 32 + 32 + 4 + 4, 0, 32); // nNonce
          memset(solution + 8, 0, 32 + 32);               // hashPrevMMRRoot, hashBlockMMRRoot
                                                          // printf("info: merged mining %d chains, clearing non-canonical data on hash found\n", numPBaaSHeaders);
        }
        else
        {
          // invalid share, pbaas activated must be pbaas mining capatible
          memset(output, 0xff, 32);
          napi_value result;
          status = napi_create_buffer_copy(env, 32, output, nullptr, &result);
          if (status != napi_ok) {
            napi_throw_error(env, nullptr, "Failed to create buffer.");
            return nullptr;
          }
          return result;
        }
      }
      else
      {
        // printf("info: merged mining %d chains, non-canonical data pre-cleared\n", numPBaaSHeaders);
      }
    }
  }

  vh2b2->Reset();
  vh2b2->Write((const unsigned char *)input, input_len);
  vh2b2->Finalize2b((unsigned char *)output);
  napi_value result;
  status = napi_create_buffer_copy(env, 32, output, nullptr, &result);
  if (status != napi_ok) {
    napi_throw_error(env, nullptr, "Failed to create buffer.");
    return nullptr;
  }
  return result;
}

napi_value init(napi_env env, napi_value exports)
{
  napi_value fn;
  napi_create_function(env, nullptr, 0, hash, nullptr, &fn);
  napi_set_named_property(env, exports, "hash", fn);
  napi_create_function(env, nullptr, 0, hash2, nullptr, &fn);
  napi_set_named_property(env, exports, "hash2", fn);
  napi_create_function(env, nullptr, 0, hash2b, nullptr, &fn);
  napi_set_named_property(env, exports, "hash2b", fn);
  napi_create_function(env, nullptr, 0, hash2b1, nullptr, &fn);
  napi_set_named_property(env, exports, "hash2b1", fn);
  napi_create_function(env, nullptr, 0, hash2b2, nullptr, &fn);
  napi_set_named_property(env, exports, "hash2b2", fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
