using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

internal static class CosmicDpapi
{
    private static int Main()
    {
        byte[] data = null;
        byte[] result = null;
        try
        {
            var line = Console.ReadLine();
            if (line == null || line.Length > 20000) throw new Exception();
            var json = new JavaScriptSerializer();
            var request = json.DeserializeObject(line) as Dictionary<string, object>;
            if (request == null || request.Count != 2 || !request.ContainsKey("op") || !request.ContainsKey("data")) throw new Exception();
            var op = request["op"] as string;
            var encoded = request["data"] as string;
            if (encoded == null || encoded.Length == 0) throw new Exception();
            data = Convert.FromBase64String(encoded);
            if (Convert.ToBase64String(data) != encoded || data.Length > 12288) throw new Exception();
            var entropy = Encoding.UTF8.GetBytes("cosmic-account-key-v1");
            if (op == "protect" && data.Length == 32)
                result = ProtectedData.Protect(data, entropy, DataProtectionScope.CurrentUser);
            else if (op == "unprotect")
                result = ProtectedData.Unprotect(data, entropy, DataProtectionScope.CurrentUser);
            else throw new Exception();
            if (op == "unprotect" && result.Length != 32) throw new Exception();
            Console.WriteLine(json.Serialize(new Dictionary<string, string> { { "data", Convert.ToBase64String(result) } }));
            return 0;
        }
        catch
        {
            Console.WriteLine("{\"error\":\"ACCOUNT_KEYSTORE\"}");
            return 1;
        }
        finally
        {
            if (data != null) Array.Clear(data, 0, data.Length);
            if (result != null) Array.Clear(result, 0, result.Length);
        }
    }
}
